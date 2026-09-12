// DeepSeek streaming chat-completion runner (with MCP tool-call loop).
// Structural clone of openai.js (chat/completions branch), 2026-08-23.
// DeepSeek's API is OpenAI-compatible (same /v1/chat/completions shape,
// same function-calling schema), so this reuses the same tool-loop + streaming
// SSE parser as openai.js. Differences vs OpenAI:
//   - endpoint: api.deepseek.com/v1  (env: DEEPSEEK_API_KEY)
//   - default model: deepseek-v4-flash
//   - no Responses API (chat/completions only)
//   - reasoning: use deepseek-v4-pro for thinking-mode workloads
//     (legacy deepseek-reasoner name deprecated 2026-07-24)
// Pricing lives in pricing.js under the "deepseek" provider key.
const path = require("path");
const { PROJECTS_DIR } = require("../paths");
const mcpDiscover = require("../mcp/discover");
const mcpTranslate = require("../mcp/translate");
const builtinTools = require("../tools-builtin");
const { buildHistory, buildProjectContext, FetchProc, loadChatSystemPrompt } = require("./context");
const { activeProcs } = require("../proc-state");
const governor = require("../governor");
const { priceTokens } = require("../pricing");

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";

function runDeepSeek({ prompt, sessionId, model, project, effort }, onData, onDone) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    setTimeout(() => onDone(1, "DEEPSEEK_API_KEY not set — add it to ~/.llm-terminal/env and restart"), 0);
    return { kill() {}, pid: -1, on() {} };
  }
  const controller = new AbortController();
  const proc = new FetchProc(controller);
  activeProcs.add(proc);
  const startTime = Date.now();
  const projectCwd = project ? path.join(PROJECTS_DIR, project) : null;
  const MAX_TOOL_ITERATIONS = 12;

  (async () => {
    try {
      const _logModel = (model || "<default>");
      console.log("[deepseek] spawn session=" + (sessionId || "?").slice(0, 8) + " model=" + _logModel + " effort=" + (effort || "max"));

      // MCP tool discovery (same shared machinery as openai.js).
      let mcpTools = [];
      try {
        if (projectCwd) mcpTools = await mcpDiscover.discoverTools(projectCwd);
      } catch (e) {
        console.warn("[runDeepSeek] tool discovery failed:", e.message);
      }
      const allTools = [...builtinTools.listBuiltinTools(), ...mcpTools];
      const dsTools = allTools.length ? mcpTranslate.toOpenAITools(allTools) : [];
      const routing = mcpTranslate.buildRouting(mcpTools);

      const history = buildHistory(sessionId, prompt, { includeToolContext: true });
      const projectCtx = buildProjectContext(project);
      const chatPrompt = loadChatSystemPrompt();
      const sysPrompt = projectCtx ? (projectCtx + "\n\n" + chatPrompt) : chatPrompt;
      const messages = [{ role: "system", content: sysPrompt }, ...history];

      let fullText = "";
      const _usage = { in: 0, out: 0 };

      // Outer loop — alternate model→tool→model until the model returns a
      // text-only response or we hit the iteration cap.
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const body = {
          model: model || DEEPSEEK_DEFAULT_MODEL,
          stream: true,
          stream_options: { include_usage: true },
          messages,
        };
        if (dsTools.length > 0) body.tools = dsTools;

        const res = await fetch(DEEPSEEK_BASE + "/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          activeProcs.delete(proc);
          proc._emitClose(1);
          onDone(1, `DeepSeek API ${res.status}: ${errBody.slice(0, 500)}`);
          return;
        }

        const turnText = [];
        const toolCalls = [];
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload);
              if (obj.usage) { _usage.in += obj.usage.prompt_tokens || 0; _usage.out += obj.usage.completion_tokens || 0; }
              const choice = obj.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta || {};
              if (delta.content) {
                turnText.push(delta.content);
                fullText += delta.content;
                onData({ type: "assistant", message: { content: [{ type: "text", text: delta.content }] } });
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index || 0;
                  if (!toolCalls[idx]) toolCalls[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
                  if (tc.id) toolCalls[idx].id = tc.id;
                  if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                }
              }
            } catch {}
          }
        }

        if (toolCalls.length === 0) break;
        if (iter === MAX_TOOL_ITERATIONS - 1) {
          messages.push({ role: "system", content: "STOP CALLING TOOLS. You have reached the maximum tool iterations for this turn. Reply now in plain text — describe what you accomplished, any issues, and what you would do next. The user is waiting for your written reply." });
        }

        messages.push({
          role: "assistant",
          content: turnText.join("") || null,
          tool_calls: toolCalls,
        });

        for (const tc of toolCalls) {
          const fnName = tc.function.name || "";
          const route = routing.get(fnName);
          const isBuiltin = builtinTools.hasBuiltin(fnName);
          let argsObj;
          try { argsObj = JSON.parse(tc.function.arguments || "{}"); } catch { argsObj = {}; }

          const useId = tc.id || `ds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const displayName = isBuiltin ? fnName : (route ? route.originalName : fnName);
          onData({ type: "assistant", message: { content: [{ type: "tool_use", name: displayName, input: argsObj, id: useId }] } });

          let resultContent;
          let isError = false;
          if (isBuiltin) {
            try {
              const r = await builtinTools.callBuiltin(fnName, argsObj, { projectCwd, sessionId });
              resultContent = r.content || [];
              isError = !!r.isError;
            } catch (e) {
              resultContent = [{ type: "text", text: `Tool execution error: ${e.message}` }];
              isError = true;
            }
          } else if (!route) {
            resultContent = [{ type: "text", text: `Unknown tool: "${fnName}"` }];
            isError = true;
          } else {
            try {
              const r = await mcpDiscover.callTool(projectCwd, route.server, route.originalName, argsObj, 120000);
              resultContent = r.content || [];
              isError = !!r.isError;
            } catch (e) {
              resultContent = [{ type: "text", text: `Tool execution error: ${e.message}` }];
              isError = true;
            }
          }

          onData({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: useId, content: resultContent, is_error: isError }] } });

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: mcpTranslate.flattenToolResult(resultContent).slice(0, 16000),
          });
        }
      }

      // Forced-summary turn if tools ran but no text landed.
      if (!fullText.trim() && messages.some(m => m.role === "tool")) {
        messages.push({ role: "system", content: "You called tools but did not write a final reply to the user. Now reply IN PLAIN TEXT only. Describe what you did, the outcome, and any remaining gaps. Do NOT call any more tools." });
        try {
          const finalRes = await fetch(DEEPSEEK_BASE + "/chat/completions", {
            method: "POST",
            headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
            body: JSON.stringify({ model: model || DEEPSEEK_DEFAULT_MODEL, stream: true, stream_options: { include_usage: true }, messages }),
            signal: controller.signal,
          });
          if (finalRes.ok) {
            const decoder = new TextDecoder();
            let buf = "";
            for await (const chunk of finalRes.body) {
              buf += decoder.decode(chunk, { stream: true });
              const lines = buf.split("\n");
              buf = lines.pop();
              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const payload = line.slice(6).trim();
                if (payload === "[DONE]") continue;
                try {
                  const obj = JSON.parse(payload);
                  if (obj.usage) { _usage.in += obj.usage.prompt_tokens || 0; _usage.out += obj.usage.completion_tokens || 0; }
                  const t = obj.choices?.[0]?.delta?.content;
                  if (t) {
                    fullText += t;
                    onData({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
                  }
                } catch {}
              }
            }
          }
        } catch (e) { console.warn("[runDeepSeek] forced-summary turn failed:", e.message); }
      }

      const duration = Date.now() - startTime;
      const _priced = priceTokens("deepseek", model, _usage.in, _usage.out);
      governor.record("llmterminal-chat", model || "deepseek", _priced.cost_usd || 0, (sessionId || "").slice(0, 8),
        { session: sessionId || "", billing: "api", unpriced: _priced.unpriced, tokens_in: _usage.in, tokens_out: _usage.out });
      onData({ type: "result", result: fullText, duration_ms: duration, total_cost_usd: _priced.cost_usd, session_id: null });
      activeProcs.delete(proc);
      proc._emitClose(0);
      onDone(0, "");
    } catch (err) {
      activeProcs.delete(proc);
      proc._emitClose(1);
      if (err.name === "AbortError") { onDone(1, "Aborted"); return; }
      onDone(1, err.message || String(err));
    }
  })();

  return proc;
}

module.exports = { runDeepSeek };

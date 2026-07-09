// OpenAI streaming chat-completion runner (with MCP tool-call loop).
// Extracted from server.js (refactor 2026-06-10, phase 13). Streams via the
// onData/onDone callbacks; the WS handler owns persistence/broadcast.
const path = require("path");
const { PROJECTS_DIR } = require("../paths");
const mcpDiscover = require("../mcp/discover");
const mcpTranslate = require("../mcp/translate");
const builtinTools = require("../tools-builtin");
const { buildHistory, buildProjectContext, FetchProc, loadChatSystemPrompt } = require("./context");
const { activeProcs } = require("../proc-state");

// Map our internal tool list to the Responses API tool shape — flat
// {type:"function", name, description, parameters} — distinct from the
// chat/completions shape, which nests those under a `function` key.
function toResponsesTools(allTools) {
  const chat = mcpTranslate.toOpenAITools(allTools);
  return chat.map(t => {
    const f = t.function || {};
    return { type: "function", name: f.name, description: f.description, parameters: f.parameters };
  });
}

// gpt-5.x reasoning models REQUIRE /v1/responses for tool-calling + reasoning
// effort (chat/completions rejects the combination with a 400). This mirrors
// the chat/completions tool loop below but speaks the Responses protocol:
// typed SSE events, function_call / function_call_output items, and
// previous_response_id chaining — which carries reasoning items server-side,
// as OpenAI recommends for function calling with reasoning models. Returns the
// accumulated assistant text.
async function runResponsesLoop({ key, model, effort, sysPrompt, history, respTools, routing, projectCwd, sessionId, controller, onData, MAX_TOOL_ITERATIONS }) {
  const RESP_URL = "https://api.openai.com/v1/responses";
  // Responses supports none|low|medium|high|xhigh. We expose low/medium/high
  // and map our "max" to "high" (xhigh is reserved for async eval-grade work —
  // too slow/costly for an interactive chat default).
  const _EFFORT = { low: "low", medium: "medium", high: "high", max: "high" };
  const reasoningEffort = _EFFORT[(effort || "max").toLowerCase()] || "high";
  let fullText = "";
  let prevId = null;
  // First turn: replay history as input Items; system prompt rides `instructions`.
  let nextInput = history.map(m => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));

  // Stream one /v1/responses turn. Mutates fullText (text deltas) via closure;
  // returns the function_call items and the response id for chaining.
  const _stream = async (body) => {
    const res = await fetch(RESP_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const e = await res.text().catch(() => "");
      throw new Error(`OpenAI Responses API ${res.status}: ${e.slice(0, 500)}`);
    }
    const toolCalls = [];
    let responseId = null;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj.response && obj.response.id) responseId = obj.response.id;
        const t = obj.type;
        if (t === "response.output_text.delta" && typeof obj.delta === "string") {
          fullText += obj.delta;
          onData({ type: "assistant", message: { content: [{ type: "text", text: obj.delta }] } });
        } else if (t === "response.output_item.done" && obj.item && obj.item.type === "function_call") {
          toolCalls.push({ call_id: obj.item.call_id, name: obj.item.name, arguments: obj.item.arguments || "" });
        } else if (t === "response.failed" || t === "error") {
          const msg = (obj.response && obj.response.error && obj.response.error.message) || obj.message || "stream error";
          throw new Error("OpenAI Responses API: " + msg);
        }
      }
    }
    return { toolCalls, responseId };
  };

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const body = { model: model || "gpt-5.5", stream: true, reasoning: { effort: reasoningEffort } };
    if (respTools.length) body.tools = respTools;
    if (prevId) { body.previous_response_id = prevId; body.input = nextInput; }
    else { body.instructions = sysPrompt; body.input = nextInput; }
    if (iter === MAX_TOOL_ITERATIONS - 1) body.tool_choice = "none"; // last turn → force a text answer

    const { toolCalls, responseId } = await _stream(body);
    if (!toolCalls.length) break;
    if (iter === MAX_TOOL_ITERATIONS - 1) break;

    const outputs = [];
    for (const tc of toolCalls) {
      const fnName = tc.name || "";
      const route = routing.get(fnName);
      const isBuiltin = builtinTools.hasBuiltin(fnName);
      let argsObj;
      try { argsObj = JSON.parse(tc.arguments || "{}"); } catch { argsObj = {}; }
      const useId = tc.call_id || `oai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const displayName = isBuiltin ? fnName : (route ? route.originalName : fnName);
      onData({ type: "assistant", message: { content: [{ type: "tool_use", name: displayName, input: argsObj, id: useId }] } });

      let resultContent, isError = false;
      if (isBuiltin) {
        try { const r = await builtinTools.callBuiltin(fnName, argsObj, { projectCwd, sessionId }); resultContent = r.content || []; isError = !!r.isError; }
        catch (e) { resultContent = [{ type: "text", text: `Tool execution error: ${e.message}` }]; isError = true; }
      } else if (!route) {
        resultContent = [{ type: "text", text: `Unknown tool: "${fnName}"` }]; isError = true;
      } else {
        try { const r = await mcpDiscover.callTool(projectCwd, route.server, route.originalName, argsObj, 120000); resultContent = r.content || []; isError = !!r.isError; }
        catch (e) { resultContent = [{ type: "text", text: `Tool execution error: ${e.message}` }]; isError = true; }
      }
      onData({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: useId, content: resultContent, is_error: isError }] } });
      outputs.push({ type: "function_call_output", call_id: tc.call_id, output: mcpTranslate.flattenToolResult(resultContent).slice(0, 16000) });
    }
    prevId = responseId;          // chain: the function_call + reasoning ride server-side
    nextInput = outputs;          // submit only the tool outputs next turn
  }

  // Final wrap-up: tools ran but no text landed — force a closing plain-text reply.
  if (!fullText.trim() && prevId) {
    try {
      await _stream({
        model: model || "gpt-5.5", stream: true, reasoning: { effort: reasoningEffort },
        previous_response_id: prevId, tool_choice: "none",
        input: [{ role: "developer", content: "You called tools but did not write a final reply to the user. Now reply IN PLAIN TEXT only: what you did, the outcome, and any remaining gaps. Do NOT call any more tools." }],
      });
    } catch (e) { console.warn("[runOpenAI/responses] forced-summary turn failed:", e.message); }
  }
  return fullText;
}

function runOpenAI({ prompt, sessionId, model, project, effort }, onData, onDone) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    setTimeout(() => onDone(1, "OPENAI_API_KEY not set — add it to ~/.llm-terminal/env and restart"), 0);
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
      // 1. Discover MCP tools available in this project (currently: Playwright,
      //    plus whatever else is wired into .claude.json for this project).
      const _oaiLogModel = (model || "<default>");
      const _oaiE = (effort || "max").toLowerCase();
      const _oaiEffortFlag = /^(o\d|gpt-5)/.test(_oaiLogModel.toLowerCase()) ? (_oaiE === "max" ? "high" : _oaiE) : "default";
      console.log("[openai] spawn session=" + (sessionId||"?").slice(0,8) + " model=" + _oaiLogModel + " effort=" + _oaiEffortFlag);
      let mcpTools = [];
      try {
        if (projectCwd) mcpTools = await mcpDiscover.discoverTools(projectCwd);
      } catch (e) {
        console.warn("[runOpenAI] tool discovery failed:", e.message);
      }
      // Built-in tools (Bash/Read/Write/Edit/Grep/Glob) are merged with MCP
      // tools and presented to the model as one flat catalog. MCP tools win on
      // name collision (unlikely — built-in names match Claude's, MCP names
      // are server-prefixed in practice).
      const allTools = [...builtinTools.listBuiltinTools(), ...mcpTools];
      const oaiTools = allTools.length ? mcpTranslate.toOpenAITools(allTools) : [];
      const routing = mcpTranslate.buildRouting(mcpTools);

      // 2. Initial conversation: system prompt + replayed user/assistant
      //    history (without tool history — v1; replay across turns later).
      const history = buildHistory(sessionId, prompt, { includeToolContext: true });
      const projectCtx = buildProjectContext(project);
      const chatPrompt = loadChatSystemPrompt();
      const sysPrompt = projectCtx ? (projectCtx + "\n\n" + chatPrompt) : chatPrompt;
      const messages = [{ role: "system", content: sysPrompt }, ...history];

      // 3. Branch by API. gpt-5.x reasoning models must use /v1/responses for
      //    tool-calling + reasoning_effort (chat/completions 400s on the combo);
      //    "-chat" variants are non-reasoning and stay on chat/completions, as
      //    do gpt-4.x and the o-series.
      let fullText = "";
      const _rName = (model || "").toLowerCase();
      const _useResponses = /^gpt-5/.test(_rName) && !_rName.includes("chat");
      if (_useResponses) {
        const respTools = allTools.length ? toResponsesTools(allTools) : [];
        fullText = await runResponsesLoop({ key, model, effort, sysPrompt, history, respTools, routing, projectCwd, sessionId, controller, onData, MAX_TOOL_ITERATIONS });
      } else {
      // Outer loop — alternate model→tool→model until the model returns a
      // text-only response or we hit the iteration cap.
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const body = {
          model: model || "gpt-4.1",
          stream: true,
          stream_options: { include_usage: true },
          messages,
        };
        // Reasoning effort for the o-series on chat/completions (low|medium|high;
        // "max" → "high"). gpt-5.x reasoning models are routed to /v1/responses
        // above (chat/completions rejects tools + reasoning_effort for them), and
        // gpt-5*-chat / gpt-4.x are non-reasoning, so no reasoning_effort here.
        const _oaiName = (model || "").toLowerCase();
        if (/^o\d/.test(_oaiName)) {
          const _e = (effort || "max").toLowerCase();
          body.reasoning_effort = _e === "max" ? "high" : _e;
        }
        if (oaiTools.length > 0) body.tools = oaiTools;

        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          activeProcs.delete(proc);
          proc._emitClose(1);
          onDone(1, `OpenAI API ${res.status}: ${errBody.slice(0, 500)}`);
          return;
        }

        // Stream this turn: accumulate text deltas + tool_calls deltas.
        const turnText = [];
        const toolCalls = []; // indexed array; each {id, type, function:{name, arguments}}
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

        // If no tool calls in this turn, we're done (model wrote text + stopped).
        if (toolCalls.length === 0) break;
        // If we're about to hit the iteration cap, abandon tools for the final
        // turn and force a text summary. Same nudge in case loop end without text.
        if (iter === MAX_TOOL_ITERATIONS - 1) {
          messages.push({ role: "system", content: "STOP CALLING TOOLS. You have reached the maximum tool iterations for this turn. Reply now in plain text — describe what you accomplished, any issues, and what you would do next. The user is waiting for your written reply." });
        }

        // Persist the assistant turn into the message history with tool_calls
        // so the next call sees what we asked for.
        messages.push({
          role: "assistant",
          content: turnText.join("") || null,
          tool_calls: toolCalls,
        });

        // Execute each tool call in order, push tool messages back.
        for (const tc of toolCalls) {
          const fnName = tc.function.name || "";
          const route = routing.get(fnName);
          const isBuiltin = builtinTools.hasBuiltin(fnName);
          let argsObj;
          try { argsObj = JSON.parse(tc.function.arguments || "{}"); } catch { argsObj = {}; }

          const useId = tc.id || `oai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          // Emit tool_use so the UI renders it the same way Claude tool calls
          // do. sendToSession's onData handler saves a tool_activity row from
          // this event — we do NOT save here to avoid double-logging.
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
        // Loop back: ask the model what to do next with the tool results.
      }

      // Final-wrap-up turn: if the model used tools but never emitted a summary,
      // do one more call with tools removed and a forced-summary system msg so
      // a closing bubble always lands.
      if (!fullText.trim() && messages.some(m => m.role === "tool")) {
        messages.push({ role: "system", content: "You called tools but did not write a final reply to the user. Now reply IN PLAIN TEXT only. Describe what you did, the outcome, and any remaining gaps. Do NOT call any more tools." });
        try {
          const finalRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
            body: JSON.stringify({ model: model || "gpt-4.1", stream: true, messages }),
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
                  const t = obj.choices?.[0]?.delta?.content;
                  if (t) {
                    fullText += t;
                    onData({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
                  }
                } catch {}
              }
            }
          }
        } catch (e) { console.warn("[runOpenAI] forced-summary turn failed:", e.message); }
      }
      } // end chat/completions branch
      const duration = Date.now() - startTime;
      onData({ type: "result", result: fullText, duration_ms: duration, total_cost_usd: null, session_id: null });
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

module.exports = { runOpenAI };

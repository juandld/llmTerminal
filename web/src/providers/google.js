// Google Gemini streaming runner (with MCP tool-call loop). Extracted from
// server.js (refactor 2026-06-10, phase 14). Streams via onData/onDone.
const mcpDiscover = require("../mcp/discover");
const mcpTranslate = require("../mcp/translate");
const { buildHistory, buildProjectContext, FetchProc, CHAT_SYSTEM_PROMPT, toGeminiContents } = require("./context");
const { activeProcs } = require("../proc-state");

function runGoogle({ prompt, sessionId, model, project, effort }, onData, onDone) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    setTimeout(() => onDone(1, "GOOGLE_API_KEY not set — add it to ~/.llm-terminal/env and restart"), 0);
    return { kill() {}, pid: -1, on() {} };
  }
  const controller = new AbortController();
  const proc = new FetchProc(controller);
  activeProcs.add(proc);
  const startTime = Date.now();
  const projectCwd = project ? path.join(PROJECTS_DIR, project) : null;
  const geminiModel = model || "gemini-2.5-flash";
  const MAX_TOOL_ITERATIONS = 20;

  (async () => {
    try {
      // Map effort → Gemini thinkingBudget. -1 = dynamic (model picks, up to
      // its max). Bounded values for lower tiers. Only 2.5+/3.x support it.
      const _gEff = (effort || "max").toLowerCase();
      const _gBudget = { low: 2048, medium: 8192, high: 24576, max: -1 }[_gEff] ?? -1;
      const _gThinkCapable = /^gemini-(2\.5|3)/.test((geminiModel||"").toLowerCase());
      const _gEffort = _gThinkCapable ? (_gEff + "(thinkingBudget=" + _gBudget + ")") : "default";
      console.log("[gemini] spawn session=" + (sessionId||"?").slice(0,8) + " model=" + geminiModel + " effort=" + _gEffort);
      let mcpTools = [];
      try {
        if (projectCwd) mcpTools = await mcpDiscover.discoverTools(projectCwd);
      } catch (e) {
        console.warn("[runGoogle] tool discovery failed:", e.message);
      }
      const ggTools = mcpTools.length ? mcpTranslate.toGoogleTools(mcpTools) : null;
      const routing = mcpTranslate.buildRouting(mcpTools);

      const history = buildHistory(sessionId, prompt, { includeToolContext: true });
      const projectCtx = buildProjectContext(project);
      const sysPrompt = projectCtx ? (projectCtx + "\n\n" + CHAT_SYSTEM_PROMPT) : CHAT_SYSTEM_PROMPT;
      // Gemini wants `contents` (alternating user/model) plus systemInstruction
      const contents = toGeminiContents(history);

      let fullText = "";
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const body = {
          contents,
          systemInstruction: { parts: [{ text: sysPrompt }] },
          generationConfig: _gThinkCapable
            ? { temperature: 1.0, thinkingConfig: { thinkingBudget: _gBudget } }
            : { temperature: 1.0 },
        };
        if (ggTools) body.tools = ggTools;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse&key=${key}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          activeProcs.delete(proc);
          proc._emitClose(1);
          onDone(1, `Gemini API ${res.status}: ${errBody.slice(0, 500)}`);
          return;
        }

        // Stream this turn: accumulate text parts + functionCall parts.
        // Gemini delivers parts incrementally; each chunk may have parts of
        // either kind. functionCall parts arrive complete (not delta-fragments
        // like OpenAI), so accumulation is simpler.
        const turnText = [];
        const turnCalls = []; // [{name, args}]
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;
            try {
              const obj = JSON.parse(payload);
              const parts = obj.candidates?.[0]?.content?.parts || [];
              for (const part of parts) {
                if (part.text) {
                  turnText.push(part.text);
                  fullText += part.text;
                  onData({ type: "assistant", message: { content: [{ type: "text", text: part.text }] } });
                }
                if (part.functionCall) {
                  // Gemini 3.x ships a thought_signature on the same part as a
                  // functionCall. When we reply with the matching
                  // functionResponse we MUST echo the original functionCall
                  // (with its signature) inside the prior model turn, or the
                  // next call 400s with "Function call is missing a
                  // thought_signature in functionCall parts". Capture both.
                  turnCalls.push({
                    name: part.functionCall.name || "",
                    args: part.functionCall.args || {},
                    thoughtSignature: part.thoughtSignature || null,
                  });
                }
              }
            } catch {}
          }
        }

        if (turnCalls.length === 0) break;
        if (iter === MAX_TOOL_ITERATIONS - 1) {
          contents.push({ role: "user", parts: [{ text: "[system] STOP CALLING TOOLS. You have reached the maximum tool iterations. Reply now in plain text describing what you accomplished and any issues." }] });
        }

        // Push the model turn into the conversation so Gemini sees what it
        // asked for on the next call.
        const modelParts = [];
        if (turnText.length) modelParts.push({ text: turnText.join("") });
        for (const c of turnCalls) {
          const part = { functionCall: { name: c.name, args: c.args } };
          if (c.thoughtSignature) part.thoughtSignature = c.thoughtSignature;
          modelParts.push(part);
        }
        contents.push({ role: "model", parts: modelParts });

        // Execute each tool call, push functionResponse parts back.
        const userParts = [];
        for (const tc of turnCalls) {
          const route = routing.get(tc.name);
          const useId = `gg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          onData({ type: "assistant", message: { content: [{ type: "tool_use", name: route ? route.originalName : tc.name, input: tc.args, id: useId }] } });

          let resultContent;
          let isError = false;
          if (!route) {
            resultContent = [{ type: "text", text: `Unknown tool: "${tc.name}"` }];
            isError = true;
          } else {
            try {
              const r = await mcpDiscover.callTool(projectCwd, route.server, route.originalName, tc.args, 120000);
              resultContent = r.content || [];
              isError = !!r.isError;
            } catch (e) {
              resultContent = [{ type: "text", text: `Tool execution error: ${e.message}` }];
              isError = true;
            }
          }

          onData({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: useId, content: resultContent, is_error: isError }] } });

          userParts.push({
            functionResponse: {
              name: tc.name,
              response: { content: mcpTranslate.flattenToolResult(resultContent).slice(0, 16000) },
            },
          });
        }
        contents.push({ role: "user", parts: userParts });
      }

      // Final wrap-up turn: if Gemini used tools but never wrote text, force a
      // tool-less summary call so a closing bubble always lands.
      if (!fullText.trim() && contents.some(c => c.parts?.some(p => p.functionResponse))) {
        contents.push({ role: "user", parts: [{ text: "[system] You called tools but did not write a final reply to the user. Now reply IN PLAIN TEXT only — describe what you did, the outcome, and any remaining gaps. Do NOT call any more tools." }] });
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse&key=${key}`;
          const finalRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: sysPrompt }] }, generationConfig: _gThinkCapable ? { temperature: 1.0, thinkingConfig: { thinkingBudget: _gBudget } } : { temperature: 1.0 } }),
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
                if (!payload) continue;
                try {
                  const obj = JSON.parse(payload);
                  const parts = obj.candidates?.[0]?.content?.parts || [];
                  for (const part of parts) {
                    if (part.text) {
                      fullText += part.text;
                      onData({ type: "assistant", message: { content: [{ type: "text", text: part.text }] } });
                    }
                  }
                } catch {}
              }
            }
          }
        } catch (e) { console.warn("[runGoogle] forced-summary turn failed:", e.message); }
      }
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

module.exports = { runGoogle };

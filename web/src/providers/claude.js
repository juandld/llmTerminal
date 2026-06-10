// providers/claude: the Claude CLI runner + spawn helpers (_bwrapWrap sandbox,
// killExistingClaudeFor) + headless queue executors (fireQueueHeadless/tryDrainQueue,
// bundled to resolve their circular call with runClaude). Extracted 2026-06-11.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { PROJECTS_DIR } = require("../paths");
const { loadMessages, saveMessage, loadSessions, updateSessionInStore, _persistSessionIfNew, ensureProjectTrusted } = require("../store");
const { wsSend, broadcastToSession, getWss } = require("../ws/broadcast");
const { activeProcs, activeProcBySession } = require("../proc-state");
const { sessionPermissions } = require("../permissions");
const { getProvider } = require("./context");
const { autoDetectBashFiles, autoCreatePreview, summarizeToolUse } = require("../tools");
const { spawnObserver, spawnDecisionExtractor, spawnContractCheck, reconcileFileAttribution } = require("../supervisors");
const { generateSessionTitle } = require("../session-title");

function fireQueueHeadless(sessionId) {
  if (activeProcBySession.has(sessionId)) return;
  const next = queuePopNext(sessionId);
  if (!next) return;
  const sessions0 = loadSessions();
  const session = sessions0.find(s => s.id === sessionId);
  if (!session) { console.error("[queue-headless] session not found:", sessionId); return; }
  console.log("[queue-headless] firing for", sessionId, ":", next.text.slice(0, 80));
  session.messageCount = (session.messageCount || 0) + 1;
  session.lastActive = Date.now();
  _persistSessionIfNew(session);
  updateSessionInStore(session);
  const firingTs = next.ts || Date.now();
  saveMessage(sessionId, { role: "user", text: next.text, ts: firingTs, source: next.source, client_id: next.client_id });
  broadcastToSession(sessionId, { type: "queued_prompt_firing", text: next.text, source: next.source, client_id: next.client_id, ts: firingTs });
  broadcastToSession(sessionId, { type: "thinking", session_id: sessionId });
  broadcastQueueState(sessionId);
  const cwd = path.join(PROJECTS_DIR, session.project);
  const _effort = session.effort || "max";
  ensurePermissionsLoaded(sessionId);
  const perms = sessionPermissions[sessionId];
  const extraAllowedTools = perms ? [...perms] : [];
  const _provider = getProvider(session.model);
  const _runFn = _provider === "openai" ? runOpenAI : _provider === "google" ? runGoogle : runClaude;
  const _runArgs = _provider === "claude"
    ? { project: session.project, prompt: next.text, claudeSessionId: session.claudeSessionId, cwd, extraAllowedTools, model: session.model, sessionId, effort: _effort }
    : { prompt: next.text, sessionId, model: session.model, project: session.project, effort: _effort };
  if (_provider === "claude") killExistingClaudeFor(session.claudeSessionId);
  let _assistantTextEmittedThisTurn = false;
  let lastToolUse = null;
  let gotResult = false;
  const pendingPreviews = {};
  const proc = _runFn(
    _runArgs,
    (data) => {
      if (data.type === "system" && data.subtype === "init") {
        if (data.session_id && !session.claudeSessionId) {
          session.claudeSessionId = data.session_id;
          updateSessionInStore(session);
        }
        return;
      }
      if (data.type === "assistant") {
        const content = data.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              _assistantTextEmittedThisTurn = true;
              broadcastToSession(sessionId, { type: "text", text: block.text, session_id: sessionId });
            }
            if (block.type === "tool_use") {
              lastToolUse = { name: block.name, input: block.input, id: block.id };
              if (["Write","Edit","MultiEdit","NotebookEdit"].includes(block.name))
                pendingPreviews[block.id] = { tool_name: block.name, input: block.input };
              if (block.name === "Bash")
                pendingPreviews[block.id] = { tool_name: "Bash", input: block.input };
              if (block.name === "Read" && typeof block.input?.file_path === "string"
                  && block.input.file_path.startsWith("/home/claude-user/projects/"))
                autoDetectBashFiles(block.input.file_path, sessionId, cwd);
              if (block.name !== "AskUserQuestion") {
                const summary = summarizeToolUse(block.name, block.input);
                saveMessage(sessionId, { role: "tool_activity", tool_name: block.name, summary, ts: Date.now() });
              }
              broadcastToSession(sessionId, { type: "tool_use", name: block.name, input: block.input, session_id: sessionId });
            }
          }
        }
      }
      if (data.type === "user" && data.message?.content) {
        const content = Array.isArray(data.message.content) ? data.message.content : [];
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id && pendingPreviews[block.tool_use_id]) {
            const pending = pendingPreviews[block.tool_use_id];
            delete pendingPreviews[block.tool_use_id];
            if (!block.is_error) {
              if (pending.tool_name === "Bash") {
                const stdout = Array.isArray(block.content) ? (block.content[0]?.text || "") : String(block.content || "");
                autoDetectBashFiles(stdout, sessionId, cwd);
              } else {
                autoCreatePreview(pending, sessionId);
              }
            }
          }
          if (block.type === "tool_result" && !block.is_error) {
            try {
              const txt = Array.isArray(block.content) ? (block.content[0]?.text || "") : String(block.content || "");
              if (txt && /\/home\/claude-user\/projects\//.test(txt)) autoDetectBashFiles(txt, sessionId, cwd);
            } catch {}
          }
        }
      }
      if (data.type === "result") {
        gotResult = true;
        const result = data.result || "";
        const isApiError = data.is_error === true || /^API Error:\s*\d{3}/.test(result);
        if (isApiError) {
          broadcastToSession(sessionId, { type: "api_error", message: result.slice(0, 500), session_id: sessionId });
          saveMessage(sessionId, { role: "api_error", text: result.slice(0, 500), ts: Date.now() });
        } else {
          let _resultClean = result.replace(/```email-draft\n[\s\S]*?\n```\s*/g, "").trim();
          if (_resultClean) {
            saveMessage(sessionId, { role: "assistant", text: _resultClean, ts: Date.now(), cost: data.total_cost_usd, duration: data.duration_ms });
            try {
              const _allSessions2 = loadSessions();
              const _s2 = _allSessions2.find(x => x.id === sessionId);
              if (_s2) {
                const _userMsgs2 = loadMessages(sessionId).filter(m => m.role === "user").length;
                if ((!_s2.titleGenerated && _userMsgs2 >= 1) || (_s2.titleGenerated && (_userMsgs2 - (_s2.titleUserMsgs || 0)) >= 3))
                  generateSessionTitle(sessionId);
              }
            } catch (e) { console.warn("[title-gen headless]", e.message); }
          }
          if (lastToolUse && !_assistantTextEmittedThisTurn) {
            saveMessage(sessionId, { role: "assistant", text: "_(Agent finished its tool work without a written summary. Re-prompt if you want it to recap or continue.)_", ts: Date.now(), cost: data.total_cost_usd, duration: data.duration_ms, synthetic: "empty-result-after-tools" });
          }
          broadcastToSession(sessionId, { type: "done", result, cost: data.total_cost_usd, duration: data.duration_ms, session_id: sessionId });
        }
        setTimeout(() => { try { spawnDecisionExtractor(sessionId, session.project); } catch {} }, 800);
        setTimeout(() => { try { spawnContractCheck(sessionId, session.project); } catch {} }, 1100);
      }
    },
    (code, stderr) => {
      activeProcBySession.delete(sessionId);
      if (!gotResult) {
        const msgs2 = loadMessages(sessionId);
        const last = msgs2.length ? msgs2[msgs2.length - 1] : null;
        if (last && new Set(["tool_activity","tool_result","permission_granted"]).has(last.role)) {
          const note = code === 0
            ? "⚠️ The agent stopped mid-run without producing a final response. Re-prompt to continue."
            : "⚠️ The agent process exited (code " + code + ") before producing a final response. Re-prompt to retry.";
          saveMessage(sessionId, { role: "assistant", text: note, ts: Date.now(), recovered: true, stalled: true });
        }
      }
      broadcastToSession(sessionId, { type: "idle", session_id: sessionId });
      setTimeout(() => { try { tryDrainQueue(sessionId); } catch (e) { console.error("[queue-headless] next drain:", e.message); } }, 50);
    }
  );
  if (proc) activeProcBySession.set(sessionId, proc);
}

// Drain the next queued prompt for a session. Called when:
//   - an active claude run finishes (in sendToSession's onDone)
//   - a fresh voice-note transcript arrives and we want to fire it ASAP
//   - a WS reconnects with pending items
function tryDrainQueue(sessionId) {
  if (!sessionId) return;
  // Find the WS client(s) for this session
  let target = null;
  for (const c of getWss().clients) {
    if (c._llmSessionId === sessionId && c.readyState === 1 && typeof c._sendToSession === "function") {
      target = c; break;
    }
  }
  if (!target) {
    // No live client — fire headlessly so queue drains without needing a reconnect
    fireQueueHeadless(sessionId);
    return;
  }
  if (activeProcBySession.has(sessionId)) return; // a run is active for this session (maybe on another WS) — its onDone will drain
  const next = queuePopNext(sessionId);
  if (!next) return;
  console.log("[queue] firing for", sessionId, ":", next.text.slice(0, 60));
  // Save the user message + render in chat. Use the WS's in-memory session
  // (which may be pending/not-yet-on-disk). _persistSessionIfNew flips it to
  // persisted before we write the message — voice-notes routed via nonce now
  // create the session record the same way a typed prompt does.
  const session = target._llmSession;
  if (!session) { console.error("[queue] no in-memory session on WS for:", sessionId); return; }
  session.messageCount = (session.messageCount || 0) + 1;
  session.lastActive = Date.now();
  _persistSessionIfNew(session);
  updateSessionInStore(session);
  const firingTs = next.ts || Date.now();
  saveMessage(sessionId, { role: "user", text: next.text, ts: firingTs, source: next.source, client_id: next.client_id });
  try { target.send(JSON.stringify({ type: "queued_prompt_firing", text: next.text, source: next.source, client_id: next.client_id, ts: firingTs })); } catch {}
  try { target.send(JSON.stringify({ type: "thinking" })); } catch {}
  // Tell every client on this session that one item just left the queue, so the
  // pending-bubble list re-renders without the popped item.
  broadcastQueueState(sessionId);
  target._sendToSession(next.text, false);
}

// ---- killExistingClaudeFor ----
// Belt-and-suspenders: if any claude process is currently running with
// --resume <claudeSessionId>, kill it before we spawn another one. Avoids
// double-resume races when the server restarts mid-prompt and the orphan
// claude survives across the restart.
function killExistingClaudeFor(claudeSessionId) {
  if (!claudeSessionId || !/^[A-Za-z0-9-]{8,}$/.test(claudeSessionId)) return;
  try {
    const cmd = 'pkill -TERM -f "claude.*--resume ' + claudeSessionId + '" || true';
    require("child_process").execSync(cmd, { stdio: "ignore", shell: "/bin/bash" });
  } catch {}
}

// ---- camoHero filesystem sandbox ----
// Returns {cmd, args} that wraps claudeArgs in `bwrap` when the project
// is camoHero, restricting filesystem visibility to camoHero only.
// For any other project (crankHero, narrativeHero, etc) we bypass the
// sandbox to preserve existing cross-project paths (data/_client.py imports,
// shared dataHero modules, etc).
const SANDBOXED_PROJECTS = new Set(["camoHero"]);
function _bwrapWrap(project, claudeArgs) {
  if (!SANDBOXED_PROJECTS.has(project)) {
    return { cmd: "/usr/bin/claude", args: claudeArgs };
  }
  const projDir = "/home/claude-user/projects/" + project;
  const args = [
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/etc", "/etc",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve",
    "--tmpfs", "/home/claude-user",
    // Make /home/claude-user/projects a read-only tmpfs. The project's own dir
    // gets re-bound rw below. Any write to other paths under projects/ (e.g. an
    // agent scaffolding into /home/claude-user/projects/foo/) fails with EROFS
    // instead of silently disappearing into the parent tmpfs on bwrap exit.
    "--tmpfs", "/home/claude-user/projects",
    "--dir", projDir,
    "--remount-ro", "/home/claude-user/projects",
    "--bind", projDir, projDir,
    "--bind", "/home/claude-user/.claude", "/home/claude-user/.claude",
    "--ro-bind", "/home/claude-user/.claude.json", "/home/claude-user/.claude.json",
    "--bind", "/home/claude-user/.local", "/home/claude-user/.local",
    "--bind", "/home/claude-user/.cache", "/home/claude-user/.cache",
    "--bind", "/home/claude-user/.npm", "/home/claude-user/.npm",
    "--bind", "/home/claude-user/.config", "/home/claude-user/.config",
    // RO-bind the llmTerminal uploads dir so the agent can read screenshots /
    // images the user attaches. Other ll-terminal state (sessions.db,
    // sessions.json, permissions/) stays out of the sandbox.
    "--ro-bind", "/home/claude-user/.llm-terminal/uploads", "/home/claude-user/.llm-terminal/uploads",
    "--bind", "/tmp", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--", "/usr/bin/claude",
    ...claudeArgs,
  ];
  return { cmd: "/usr/bin/bwrap", args };
}

// ---- generateSessionTitle ----
// Titles a chat from its RECENT user/assistant messages. Fires after the first
// exchange and then periodically as the chat grows (see the trigger in the result
// handler), so a long voice-note session that drifts across topics keeps a sidebar
// title reflecting what it's currently about. Fire-and-forget; ~5-15s. Tools
// disabled so the model can't wander off researching before it answers.
const _titlingInProgress = new Set(); // sessionIds with an in-flight title-gen (prevents overlap)
function runClaude({ project, prompt, claudeSessionId, cwd, extraAllowedTools, model, sessionId, effort }, onData, onDone) {
  ensureProjectTrusted(project);

  const SYSTEM_PROMPT_ADD = "When producing an email draft for david@crankwheel.com, you MUST call the mcp__crankhero-draft__draft_email tool rather than typing the draft inline. The tool validates format rules and produces a UI action card for one-tap paste on mobile. Prose drafts are strictly inferior UX.\n\nWhen presenting tabular data, ALWAYS use standard markdown pipe tables with a header row and separator row. Example:\n| Column A | Column B |\n| --- | --- |\n| value 1 | value 2 |\nNever use ASCII art tables, plain-text alignment, or code blocks for tabular data. The UI renders markdown tables as styled, mobile-friendly scrollable HTML tables.\n\nWhen you generate or modify a file the user may want to inspect (PDF, HTML, image, generated doc, invoice, report), call mcp__llmterminal__llmt_show_file with its absolute path so it appears in the user's preview drawer. Don't tell them \"can't render inline\" — pin the file instead.\n\nWhen you finish a discrete task the user asked for and there is nothing more to do unless they reply, call mcp__llmterminal__llmt_complete (optionally with a one-paragraph summary). This explicitly marks the session done so it drops out of the user's NEEDS YOU sidebar. Don't call it mid-task or while waiting on the user.";
  // Phase C: deny the hosted claude.ai Google MCPs project-wide. They
  // bypass the canonical data.* layer + use a different identity, leading
  // the agent to flail when answers don't match what data.* would give.
  const HOSTED_GOOGLE_DENY = ["mcp__claude_ai_Gmail__create_draft", "mcp__claude_ai_Gmail__create_label", "mcp__claude_ai_Gmail__get_thread", "mcp__claude_ai_Gmail__label_message", "mcp__claude_ai_Gmail__label_thread", "mcp__claude_ai_Gmail__list_drafts", "mcp__claude_ai_Gmail__list_labels", "mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__unlabel_message", "mcp__claude_ai_Gmail__unlabel_thread", "mcp__claude_ai_Google_Calendar__authenticate", "mcp__claude_ai_Google_Calendar__complete_authentication", "mcp__claude_ai_Google_Drive__authenticate", "mcp__claude_ai_Google_Drive__complete_authentication"];
  // --effort max unlocks Opus 4.7's full extended-thinking budget. Without
  // it, Claude defaults to "medium" which leaves a lot of reasoning on the
  // table — exactly the "smart model, dumb answer" symptom. Haiku ignores
  // effort levels (no thinking modes) so we skip it for cost; everything
  // else gets max.
  const _modelLower = (model || "").toLowerCase();
  // Haiku has no thinking modes — effort flag is a no-op there, skip it.
  // Otherwise honor the session's chosen effort (low|medium|high|max),
  // defaulting to max.
  const _effort = (effort || "max").toLowerCase();
  const _applyEffort = !_modelLower.includes("haiku");
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--add-dir", "/home/claude-user/projects", "--append-system-prompt", SYSTEM_PROMPT_ADD, "--disallowedTools", ...HOSTED_GOOGLE_DENY];
  if (_applyEffort) args.push("--effort", _effort);
  // Per-session model override. session.model is set via WS "set_model"
  // and persisted in sessions.json. Aliases (opus/sonnet/haiku) and full
  // names (claude-sonnet-4-6 etc.) both work — claude CLI handles either.
  // Validate to a small allowlist so no surprise CLI flags slip through.
  // DEFAULT: claude-opus-4-7 (David: "highest effort and highest model" — every
  // chat starts on opus unless explicitly downgraded via the model dropdown).
  const ALLOWED_MODEL_RE = /^[a-z][a-z0-9.-]{1,80}$/;
  const chosenModel = (model && ALLOWED_MODEL_RE.test(model)) ? model : "claude-opus-4-7";
  args.push("--model", chosenModel);
  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
  }
  // Include any session-granted permissions
  if (extraAllowedTools && extraAllowedTools.length > 0) {
    args.push("--allowedTools", ...extraAllowedTools);
  }

  const _wrap = _bwrapWrap(project, args);
  if (project === "camoHero") console.log("[sandbox] spawning camoHero in bwrap");
  console.log("[claude] spawn session=" + (sessionId||"?").slice(0,8) + " model=" + (model || "<default>") + " effort=" + (_applyEffort ? _effort : "n/a-haiku"));
  const childEnv = { HOME: "/home/claude-user", TERM: "dumb", LANG: "en_US.UTF-8", PATH: process.env.PATH };
  // LLMT_SESSION_ID + LLMT_PROJECT_NAME are read by the llmterminal MCP server
  // so its tools (llmt_show_file, llmt_complete) know which session to update
  // and can enforce project-level isolation for file previews.
  if (sessionId) childEnv.LLMT_SESSION_ID = sessionId;
  if (project) childEnv.LLMT_PROJECT_NAME = project;
  const proc = spawn(_wrap.cmd, _wrap.args, {
    cwd,
    env: childEnv,
    uid: 1000,
    gid: 1000,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  activeProcs.add(proc);
  proc.on("close", () => activeProcs.delete(proc));

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    // Process complete JSON lines
    const lines = stdout.split("\n");
    stdout = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        onData(msg);
      } catch {}
    }
  });

  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  proc.on("close", (code) => {
    // Process remaining stdout
    if (stdout.trim()) {
      try { onData(JSON.parse(stdout)); } catch {}
    }
    onDone(code, stderr);
  });

  return proc;
}

// ---- WebSocket ----

module.exports = { runClaude, fireQueueHeadless, tryDrainQueue, killExistingClaudeFor };

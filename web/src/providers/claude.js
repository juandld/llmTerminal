// providers/claude: the Claude CLI runner + spawn helpers (_bwrapWrap sandbox,
// killExistingClaudeFor) + headless queue executors (fireQueueHeadless/tryDrainQueue,
// bundled to resolve their circular call with runClaude). Extracted 2026-06-11.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { PROJECTS_DIR } = require("../paths");
const { loadMessages, saveMessage, loadSessions, updateSessionInStore, _persistSessionIfNew, ensureProjectTrusted, db } = require("../store");
const { wsSend, broadcastToSession, getWss } = require("../ws/broadcast");
const { activeProcs, activeProcBySession } = require("../proc-state");
const { sessionPermissions, ensurePermissionsLoaded } = require("../permissions");
const { getProvider, loadChatSystemPrompt } = require("./context");
const { autoDetectBashFiles, autoCreatePreview, summarizeToolUse } = require("../tools");
const { logFileAttribution } = require("../attribution");
const { spawnDecisionExtractor, spawnContractCheck, reconcileFileAttribution } = require("../supervisors");
const { generateSessionTitle } = require("../session-title");
const { _bwrapWrap } = require("../bwrap");
const { queuePopNext, broadcastQueueState } = require("../queue");
const throttle = require("../throttle");
const runReg = require("../run-registry");
const governor = require("../governor");
const runLedger = require("../run-ledger");
const attention = require("../attention");

// ---- Transient rate-limit auto-throttle + retry ----
// On a *transient* server-side throttle we back off and re-run the same turn via
// --resume instead of stranding it half-done (the failure mode that left "go
// area 1" needing manual attention). The throttle window is shared (../throttle)
// so background fan-out calls also stand down, and concurrent sessions don't all
// retry straight back into the same throttle.
const RL_MAX_RETRIES = 4;
const RL_BASE_MS = 4000;     // 4s, doubling each attempt
const RL_CAP_MS = 60000;     // never wait more than 60s
function _rlBackoff(attempt) {
  const base = Math.min(RL_CAP_MS, RL_BASE_MS * Math.pow(2, attempt));
  return Math.round(base * (0.8 + Math.random() * 0.4)); // ±20% jitter
}

// Short human label of what a stream message represents, for the working
// heartbeat. Returns null for messages that aren't real progress.
function _workLabel(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.type === "assistant") {
    const c = msg.message && msg.message.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === "tool_use") return "running " + (b.name || "tool");
        if (b && b.type === "text" && b.text && b.text.trim()) return "writing reply";
      }
    }
    return "thinking";
  }
  if (msg.type === "user") return "reading result";
  if (msg.type === "system") return "starting";
  return null;
}

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
  saveMessage(sessionId, { role: "user", text: next.text, ts: firingTs, source: next.source, client_id: next.client_id, audioUrl: next.audioUrl, hasImages: !!next.hasImages });
  broadcastToSession(sessionId, { type: "queued_prompt_firing", text: next.text, source: next.source, client_id: next.client_id, ts: firingTs, audioUrl: next.audioUrl });
  broadcastToSession(sessionId, { type: "thinking", session_id: sessionId });
  broadcastQueueState(sessionId);
  const cwd = path.join(PROJECTS_DIR, session.project);
  const _effort = session.effort || "max";
  ensurePermissionsLoaded(sessionId);
  const perms = sessionPermissions[sessionId];
  const extraAllowedTools = perms ? [...perms] : [];
  const _provider = getProvider(session.model);
  const _runFn = _provider === "openai" ? runOpenAI : _provider === "google" ? runGoogle : runClaude;
  // Fire the image-augmented prompt (with [Image N: path] refs) if present; else plain text.
  const _firePrompt = next.promptText || next.text;
  // Wake-sourced items are machine-initiated (sweepDueWakes already governor-
  // gated them before queueing); everything else in the queue is a user prompt.
  const _govComponent = next.source === "wake" ? "llmterminal-auto" : "llmterminal-chat";
  const _runArgs = _provider === "claude"
    ? { project: session.project, prompt: _firePrompt, claudeSessionId: session.claudeSessionId, cwd, extraAllowedTools, model: session.model, sessionId, effort: _effort, governorComponent: _govComponent, spawnTrigger: next.source === "wake" ? "wake" : "user" }
    : { prompt: _firePrompt, sessionId, model: session.model, project: session.project, effort: _effort };
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
              if (block.name === "mcp__llmterminal__llmt_show_file"
                  && typeof block.input?.path === "string"
                  && block.input.path.startsWith("/home/claude-user/projects/")) {
                logFileAttribution(block.input.path, sessionId, "show_file");
              }
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
        // Release the per-session busy lock on model-idle (not OS-proc-close)
        // and drain immediately. Mirrors the same fix in ws/connection.js —
        // without this, MCP shutdown lag (Playwright especially) keeps the
        // bySession lock held for minutes after the model is done, stranding
        // any subsequent queued items until reconnect-drain or proc-close.
        if (activeProcBySession.get(sessionId) === proc) activeProcBySession.delete(sessionId);
        setTimeout(() => { try { tryDrainQueue(sessionId); } catch (e) { console.error("[queue-headless] drain after result failed:", e.message); } }, 50);
        const result = data.result || "";
        const isApiError = data.is_error === true || /^API Error:\s*\d{3}/.test(result);
        if (isApiError) {
          broadcastToSession(sessionId, { type: "api_error", message: result.slice(0, 500), session_id: sessionId });
          saveMessage(sessionId, { role: "api_error", text: result.slice(0, 500), ts: Date.now() });
          // Token-limit protocol (call-for-David A): a session/usage-limit
          // result arms an auto-resume wake at reset+7min + files a
          // low-urgency secretary item. No-op for every other API error;
          // must never break the error path.
          try { attention.handleTokenLimitError(sessionId, result); }
          catch (e) { console.warn("[token-limit] hook failed:", e.message); }
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
      // Identity-guarded: result-handler above may have already released the
      // lock and a queued drain may have spawned the next headless run, which
      // re-set bySession with the NEW proc handle. Don't clobber that entry.
      if (activeProcBySession.get(sessionId) === proc) activeProcBySession.delete(sessionId);
      if (!gotResult) {
        const msgs2 = loadMessages(sessionId);
        const last = msgs2.length ? msgs2[msgs2.length - 1] : null;
        if (last && new Set(["tool_activity","tool_result","permission_granted"]).has(last.role)) {
          const note = code === 0
            ? "⚠️ The agent stopped mid-run without producing a final response. Re-prompt to continue."
            : "⚠️ The agent process exited (code " + code + ") before producing a final response. Re-prompt to retry.";
          saveMessage(sessionId, { role: "assistant", text: note, ts: Date.now(), recovered: true, stalled: true });
          // Dead-run auto-continuation (call-for-David B): revive the task
          // through the queue unless this death was our own user-message
          // replacement kill; hard cap 2 revives/6h, secretary escalation
          // on the second death. All checks live in attention.handleDeadRun.
          try { attention.handleDeadRun(sessionId, { claudeSessionId: session.claudeSessionId, exitCode: code, cause: "exit" }); }
          catch (e) { console.warn("[auto-continue] hook failed:", e.message); }
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
  saveMessage(sessionId, { role: "user", text: next.text, ts: firingTs, source: next.source, client_id: next.client_id, audioUrl: next.audioUrl, hasImages: !!next.hasImages });
  try { target.send(JSON.stringify({ type: "queued_prompt_firing", text: next.text, source: next.source, client_id: next.client_id, ts: firingTs, audioUrl: next.audioUrl })); } catch {}
  try { target.send(JSON.stringify({ type: "thinking" })); } catch {}
  // Tell every client on this session that one item just left the queue, so the
  // pending-bubble list re-renders without the popped item.
  broadcastQueueState(sessionId);
  // Fire the IMAGE-AUGMENTED prompt text (with [Image N: path] refs) if the queue
  // item was an image-bearing prompt. Otherwise fall back to the plain transcript/text.
  target._sendToSession(next.promptText || next.text, false);
}

// ---- killExistingClaudeFor ----
// Belt-and-suspenders: if any claude process is currently running with
// --resume <claudeSessionId>, kill it before we spawn another one. Avoids
// double-resume races when the server restarts mid-prompt and the orphan
// claude survives across the restart.
function killExistingClaudeFor(claudeSessionId) {
  if (!claudeSessionId || !/^[A-Za-z0-9-]{8,}$/.test(claudeSessionId)) return;
  // Call-for-David B instrumentation: any death of this CLI session observed
  // within ~15s of this mark is OUR replacement kill (a new user message is
  // about to run) — the dead-run auto-continuer must not also revive it.
  attention.noteReplaceKill(claudeSessionId);
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

// ---- generateSessionTitle ----
// Titles a chat from its RECENT user/assistant messages. Fires after the first
// exchange and then periodically as the chat grows (see the trigger in the result
// handler), so a long voice-note session that drifts across topics keeps a sidebar
// title reflecting what it's currently about. Fire-and-forget; ~5-15s. Tools
// disabled so the model can't wander off researching before it answers.
function runClaude(opts, onData, onDone) {
  const { project, prompt, claudeSessionId, cwd, extraAllowedTools, model, sessionId, effort } = opts;
  const _attempt = opts._attempt || 0;
  // Ledger attribution for the shared usage governor. Interactive turns are the
  // default; automated re-fire callers (retries, startup recovery, wake drains)
  // pass "llmterminal-auto". Recording happens centrally on the result event
  // below, so EVERY claude spawn — user or machine — lands in the ledger.
  const _govComponent = opts.governorComponent || "llmterminal-chat";
  // Hoisted from the args-build below so the governor record sees the same
  // model string the CLI is actually invoked with.
  const ALLOWED_MODEL_RE = /^[a-z][a-z0-9.-]{1,80}$/;
  const chosenModel = (model && ALLOWED_MODEL_RE.test(model)) ? model : "claude-opus-4-7";
  ensureProjectTrusted(project);

  // --- transient rate-limit auto-retry (per attempt) ---
  // Wrap the caller's onData/onDone so a throttled turn is retried with backoff
  // instead of being forwarded as a failed/empty result. The rate-limit signal
  // can arrive either as the final "result" (is_error/text) or as a streamed
  // assistant text block followed by an unclean exit — we catch both.
  let _resolvedCsid = claudeSessionId || null;
  let _rlSeen = false;
  let _retryScheduled = false;
  let _forwardedResult = false;
  const _scheduleRetry = (why) => {
    if (_retryScheduled || _attempt >= RL_MAX_RETRIES) return false;
    // Answered-ness guard (2026-07-03): never re-fire a prompt the store already
    // shows as answered. Without this, a late/misclassified throttle signal
    // re-runs a COMPLETED turn ("ghost re-run" — repro'd live 3× on 2026-07-03,
    // triggered by assistant prose that merely *discussed* rate limits).
    // Trade-off: a genuine mid-cascade throttle after an interim message was
    // already saved will end the turn instead of retrying — acceptable; the
    // stalled-marker path still annotates, and re-prompting resumes cleanly.
    if (sessionId) {
      try {
        const _msgs = loadMessages(sessionId);
        let _lui = -1;
        for (let i = _msgs.length - 1; i >= 0; i--) {
          if (_msgs[i].role === "user") { _lui = i; break; }
        }
        if (_lui >= 0 && _msgs.slice(_lui + 1).some(m =>
              (m.role === "assistant" && !m.stalled) || m.role === "interrupted")) {
          console.log("[claude] retry suppressed — prompt already answered, session=" +
            String(sessionId).slice(0, 8) + " (" + String(why || "").replace(/\s+/g, " ").slice(0, 60) + ")");
          return false;
        }
      } catch (e) { console.error("[claude] answered-guard check failed:", e.message); }
    }
    // Governor gate (WS3a): a rate-limit retry is a machine-initiated spawn.
    // When capped or in provider cooldown, park instead of retrying — the
    // normal onDone flow then annotates the turn (stalled marker) and David
    // can re-prompt; his own turns are never gated.
    {
      const _gv = governor.check("llmterminal-auto");
      if (!_gv.ok) {
        console.log("[governor] parked rate-limit retry session=" + (sessionId || "?").slice(0, 8) + " — " + _gv.reason);
        return false;
      }
    }
    _retryScheduled = true;
    const delay = Math.max(_rlBackoff(_attempt), throttle.remaining());
    throttle.bump(delay);
    console.log("[claude] transient rate-limit session=" + (sessionId || "?").slice(0, 8) +
      " — retry " + (_attempt + 1) + "/" + RL_MAX_RETRIES + " in " + Math.round(delay / 1000) +
      "s :: " + String(why || "").replace(/\s+/g, " ").slice(0, 80));
    try {
      broadcastToSession(sessionId, { type: "thinking", session_id: sessionId });
      broadcastToSession(sessionId, { type: "notice", level: "throttle", session_id: sessionId,
        message: "⏳ API rate-limited — retrying automatically in " + Math.round(delay / 1000) +
                 "s (attempt " + (_attempt + 1) + "/" + RL_MAX_RETRIES + ")…" });
    } catch {}
    setTimeout(() => {
      try { runClaude({ ...opts, _attempt: _attempt + 1, claudeSessionId: _resolvedCsid || claudeSessionId, spawnTrigger: "rl-retry" }, onData, onDone); }
      catch (e) { console.error("[claude] retry spawn failed:", e.message); try { onDone(1, String(e)); } catch {} }
    }, delay);
    return true;
  };
  const wrappedOnData = (data) => {
    if (data && data.type === "system" && data.subtype === "init" && data.session_id) _resolvedCsid = data.session_id;
    if (data && data.type === "assistant" && Array.isArray(data.message?.content)) {
      // Only literal CLI error blocks ("API Error: 429 …") count as a throttle
      // signal. Matching arbitrary prose here caused ghost re-runs whenever the
      // assistant merely TALKED about rate limits (2026-07-03 incident).
      for (const b of data.message.content) {
        if (b && b.type === "text" && /^API Error: \d{3}/.test(b.text || "") && throttle.isTransientRateLimit(b.text)) _rlSeen = true;
      }
    }
    if (data && data.type === "result") {
      // Record-after (WS3a): every claude call — interactive or automated —
      // lands one row in the shared spend ledger. record() never throws and
      // never blocks; only check() (automated callers) can park a spawn.
      governor.record(_govComponent, chosenModel, data.total_cost_usd, (sessionId || "").slice(0, 8),
        // Claude runs on the Max plan: cost_usd is the CLI's list-price
        // equivalent, not billed dollars. Full session id → per-chat rollup.
        { session: sessionId || "", billing: "plan" });
      // A clean (non-error) result is CONTENT — never reclassify it as a
      // throttle just because its text mentions rate limits.
      if (data.is_error && (_rlSeen || throttle.isTransientRateLimit(data.result)) && _scheduleRetry(data.result || "rate-limit")) return; // suppress; retry owns it
      _forwardedResult = true;
    }
    onData(data);
  };
  const wrappedOnDone = (code, stderr) => {
    if (!_forwardedResult && !_retryScheduled && (_rlSeen || throttle.isTransientRateLimit(stderr)) && _scheduleRetry(stderr || "rate-limit")) return;
    if (_retryScheduled) return; // a retry owns the continuation
    onDone(code, stderr);
  };

  // Chat system prompt is the SSOT at web/config/chat-system-prompt.md; loaded
  // here, then appended (claude already has its own harness prompt). One Claude-only
  // note: AskUserQuestion is disabled via --disallowedTools and the chat prompt
  // tells the model to use mcp__llmterminal__llmt_ask instead.
  const SYSTEM_PROMPT_ADD = loadChatSystemPrompt() + "\n\nDo NOT use the built-in AskUserQuestion tool — it is disabled in this harness and returns a misleading error.";
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
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--add-dir", "/home/claude-user/projects", "--append-system-prompt", SYSTEM_PROMPT_ADD, "--disallowedTools", "AskUserQuestion", ...HOSTED_GOOGLE_DENY];
  if (_applyEffort) args.push("--effort", _effort);
  // Per-session model override. session.model is set via WS "set_model"
  // and persisted in sessions.json. Aliases (opus/sonnet/haiku) and full
  // names (claude-sonnet-4-6 etc.) both work — claude CLI handles either.
  // Validate to a small allowlist so no surprise CLI flags slip through.
  // DEFAULT: claude-opus-4-7 (David: "highest effort and highest model" — every
  // chat starts on opus unless explicitly downgraded via the model dropdown).
  // (chosenModel + its allowlist regex are hoisted to the top of runClaude so
  // the governor ledger records the same model string.)
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
  // Run-ledger L4: before any spawn that RESUMES a CLI session, scan for a
  // live claude already holding that same session id (the 16:59 contention
  // suspect). Logs orphan_detected loudly; kill-before-spawn is env-gated OFF.
  const _trigger = opts.spawnTrigger || (_attempt > 0 ? "rl-retry" : "user");
  if (claudeSessionId) {
    try { runLedger.checkOrphansBeforeSpawn(sessionId, claudeSessionId); }
    catch (e) { console.error("[run-ledger] orphan check failed:", e.message); }
  }
  const childEnv = {
    HOME: "/home/claude-user", TERM: "dumb", LANG: "en_US.UTF-8", PATH: process.env.PATH,
    // Bound tool execution so a single hung tool call can never wedge the whole
    // turn (e.g. a Playwright browser_evaluate against a page that never settles
    // — observed stalling sessions for 6+ min with no recovery). When a tool
    // exceeds the limit the CLI aborts it, returns an error to the model, and
    // the turn continues on its own. Per-call limits, not per-turn.
    MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT || "120000",   // 2 min / MCP tool call (Playwright etc.)
    MCP_TIMEOUT: process.env.MCP_TIMEOUT || "30000",             // 30 s MCP server startup
    BASH_DEFAULT_TIMEOUT_MS: process.env.BASH_DEFAULT_TIMEOUT_MS || "120000", // 2 min default for un-timed bash
    BASH_MAX_TIMEOUT_MS: process.env.BASH_MAX_TIMEOUT_MS || "600000",         // 10 min hard cap for bash
  };
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
  // Registry: every signal-bearing event on this run flows through the taps
  // below. runStarted also supersedes any prior wake for the session — a wake
  // is only live if the CURRENT turn's ScheduleWakeup set it.
  if (sessionId) runReg.runStarted(sessionId, proc.pid, "claude");
  // Run-ledger L4: spawn / first_output / 30s heartbeats / exit, all appended
  // to ~/.llm-terminal/run-ledger.jsonl. A spawn with a dead pid and no exit
  // entry = the previously-invisible wedge, now visible by construction.
  const _ledger = runLedger.trackRun({
    sessionId, pid: proc.pid, trigger: _trigger,
    model: chosenModel, resumeOf: claudeSessionId || null, argv: _wrap.args,
  });

  let stdout = "";
  let stderr = "";

  // ---- Live "working" heartbeat ----
  // The model can think (or a tool can run) for minutes with no stream output,
  // which makes a live turn look frozen. Emit a periodic heartbeat carrying
  // elapsed time, idle-since-last-activity, and a label of the current action,
  // so the UI can show "⏳ working · 2m10s · running Bash" and flag a real stall.
  const _hbStart = Date.now();
  let _hbLastAt = _hbStart;
  let _hbLabel = "starting";
  let _hbTools = 0;
  const _hbNote = (msg) => {
    const l = _workLabel(msg);
    if (l) { _hbLabel = l; _hbLastAt = Date.now(); if (l.indexOf("running ") === 0) _hbTools++; }
  };
  const _hbTimer = sessionId ? setInterval(() => {
    const now = Date.now();
    try {
      // Registry-backed tool telemetry: which tool is in flight, for how long,
      // against what budget — so the UI can say "running Bash 4m12s / cap 10m"
      // instead of inferring a stall from 45s of stream silence.
      const _e = runReg.getEntry(sessionId);
      const _open = _e && !_e.endedAt ? Object.values(_e.openTools || {}) : [];
      const _cur = _open.length ? _open.reduce((a, b) => (a.startedAt < b.startedAt ? a : b)) : null;
      broadcastToSession(sessionId, {
        type: "working", session_id: sessionId,
        elapsed_ms: now - _hbStart, idle_ms: now - _hbLastAt,
        last: _hbLabel, tools: _hbTools, stalled: (now - _hbLastAt) > 45000 && !_cur,
        current_tool: _cur ? _cur.name : null,
        tool_elapsed_ms: _cur ? now - _cur.startedAt : null,
        tool_budget_ms: _cur ? runReg.toolBudgetMs(_cur.name) : null,
      });
    } catch {}
  }, 3000) : null;

  proc.stdout.on("data", (chunk) => {
    if (sessionId) runReg.streamActivity(sessionId);
    _ledger.output(chunk.length);
    stdout += chunk.toString();
    // Process complete JSON lines
    const lines = stdout.split("\n");
    stdout = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        _hbNote(msg);
        if (sessionId) runReg.tap(sessionId, msg);
        wrappedOnData(msg);
      } catch {}
    }
  });

  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  proc.on("close", (code, signal) => {
    if (_hbTimer) clearInterval(_hbTimer);
    // Process remaining stdout
    if (stdout.trim()) {
      try {
        const msg = JSON.parse(stdout);
        if (sessionId) runReg.tap(sessionId, msg);
        wrappedOnData(msg);
      } catch {}
    }
    if (sessionId) runReg.runEnded(sessionId, code);
    _ledger.exit(code, signal,
      _retryScheduled ? "rl-retry-scheduled" : _forwardedResult ? "result" : "no-result");
    wrappedOnDone(code, stderr);
  });

  return proc;
}

// ---- WebSocket ----

module.exports = { runClaude, fireQueueHeadless, tryDrainQueue, killExistingClaudeFor };

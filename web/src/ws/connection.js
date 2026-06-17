// ws/connection: the WebSocket connection handler — the core message loop
// (incoming prompts -> provider runners, streaming, interrupts, queue, voice,
// reconnect). The cockpit heart. Extracted (refactor 2026-06-11).
const path = require("path");
const crypto = require("crypto");
const { PROJECTS_DIR } = require("../paths");
const { wsSend, getWss, broadcastToSession } = require("./broadcast");
const { loadMessages, saveMessage, deleteMessagesByTs, loadSessions, updateSessionInStore, _persistSessionIfNew } = require("../store");
const { getProvider } = require("../providers/context");
const { runClaude, tryDrainQueue, killExistingClaudeFor } = require("../providers/claude");
const { runOpenAI } = require("../providers/openai");
const { runGoogle } = require("../providers/google");
const { activeProcBySession } = require("../proc-state");
const { sessionPermissions, ensurePermissionsLoaded, savePermissions } = require("../permissions");
const { spawnObserver, spawnDecisionExtractor, spawnContractCheck, reconcileFileAttribution } = require("../supervisors");
const { generateSessionTitle } = require("../session-title");
const { issueVoiceNonce, revokeNoncesForWs } = require("../voice-nonce");
const { queueAppend, queueLoad, queueSaveAll, broadcastQueueState } = require("../queue");
const { summarizeToolUse, autoCreatePreview, autoDetectBashFiles } = require("../tools");
const { logFileAttribution } = require("../attribution");
const { saveUploadedImage } = require("../uploads");

function registerWsHandlers() {
getWss().on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const project = url.searchParams.get("project") || "narrativeHero";
  const resumeId = url.searchParams.get("session");

  let sessions = loadSessions();
  let session = resumeId ? sessions.find(s => s.id === resumeId) : null;
  if (!session) {
    // In-memory only — we no longer persist on connect. The session record
    // gets written to sessions.json the first time the user actually does
    // something (prompt arrives → updateSessionInStore upserts it). If the
    // user never types, nothing ever lands on disk.
    // Reuse the requested resumeId when given so the URL hash stays stable
    // across page reloads in the same draft session.
    session = {
      id: resumeId || crypto.randomUUID(),
      project,
      created: Date.now(),
      lastActive: Date.now(),
      messageCount: 0,
      title: "New session",
      claudeSessionId: null,
    };
  }

  let activeProc = null; // per-WS handle to the running child, used for local kill/interrupt; session-level busy state lives in activeProcBySession

  ws._llmSessionId = session.id; // tag for watchdog push
  ws._llmSession = session;      // in-memory reference so out-of-closure code (tryDrainQueue) can reach pending sessions
  ensurePermissionsLoaded(session.id);

  // Wrap ws.send so every outgoing message carries this connection's session_id.
  // The frontend uses this to reject any message arriving on a stale WS — even if
  // _detachWs() forgot to null the handlers, the message can't render in the
  // wrong chat's view. Defense in depth at the protocol level.
  const _origSend = ws.send.bind(ws);
  ws.send = function(data) {
    try {
      if (typeof data === "string" && data.charCodeAt(0) === 123) { // starts with "{"
        const obj = JSON.parse(data);
        if (obj && typeof obj === "object" && obj.session_id === undefined) {
          obj.session_id = ws._llmSessionId;
          data = JSON.stringify(obj);
        }
      }
    } catch {}
    return _origSend(data);
  };

  // Issue a voice-note nonce tied to this WS. The frontend uses this on
  // /voice-note POSTs so the upload proves it's coming from the currently-open
  // WS, not just any client that knows a session id.
  const voiceNonce = issueVoiceNonce(session.id, ws);
  ws._voiceNonce = voiceNonce; // for cleanup
  ws.send(JSON.stringify({ type: "session", session, voiceNonce }));

  // Send recent messages on connect (last 20), with total count for lazy
  // loading. We ALWAYS also include earlier `email_draft` and `question` rows
  // (sticky cards) so the user can still tap Open-in-Gmail / answer pending
  // questions even when the card itself is older than the 20-message window.
  // Client dedupes by `m.ts` so re-fetches of earlier ranges won't duplicate.
  const INITIAL_LIMIT = 20;
  const STICKY_ROLES = new Set(["email_draft", "question"]);
  const allMessages = loadMessages(session.id);
  const recentSlice = allMessages.slice(-INITIAL_LIMIT);
  const recentSet = new Set(recentSlice);
  const stickyEarlier = allMessages
    .slice(0, Math.max(0, allMessages.length - INITIAL_LIMIT))
    .filter(m => STICKY_ROLES.has(m.role) && !recentSet.has(m));
  const initialSlice = [...stickyEarlier, ...recentSlice];
  ws.send(JSON.stringify({
    type: "history",
    messages: initialSlice,
    total: allMessages.length,
    offset: Math.max(0, allMessages.length - recentSlice.length),
    busy: activeProcBySession.has(session.id),
  }));

  // Send current permission state so frontend knows what's already allowed
  const currentPerms = sessionPermissions[session.id];
  if (currentPerms && currentPerms.size > 0) {
    ws.send(JSON.stringify({ type: "permissions_state", permissions: [...currentPerms] }));
  }

  ws.send(JSON.stringify({ type: "status", status: "connected" }));
  // Signal that all initial sync payloads (session, history, permissions_state, status) have been sent
  ws.send(JSON.stringify({ type: "ready" }));
  // If anything was queued while this session was offline, fire the next one now
  setTimeout(() => { try { tryDrainQueue(session.id); } catch {} }, 200);
  // Tell client current queue depth + contents so it can render pending bubbles
  // (not just an "N queued" badge). Always emit so a reconnected client clears
  // stale pending bubbles if the queue is now empty.
  {
    const items = queueLoad(session.id).map(it => ({
      text: it.text || "",
      source: it.source || "prompt",
      client_id: it.client_id || null,
      ts: it.ts || null,
    }));
    wsSend(ws, "queue_state", { queueDepth: items.length, items });
  }

  // Heartbeat: ping client every 20s
  const pingInterval = setInterval(() => {
    if (ws.readyState !== 1) return;
    wsSend(ws, "ping", { ts: Date.now() });
  }, 20000);

  // Hoisted so permission_grant can call it for auto-retry
  ws._sendToSession = function(promptText, isRetry) { return sendToSession(promptText, isRetry); };
  function sendToSession(promptText, isRetry) {
    const cwd = path.join(PROJECTS_DIR, session.project);
    // No system prompt injection — file previews are auto-created server-side
    // by detecting Write/Edit tool_use events in the stream.
    const fullPrompt = promptText;
    ensurePermissionsLoaded(session.id);
    const perms = sessionPermissions[session.id];
    const extraAllowedTools = perms ? [...perms] : [];
    let lastToolUse = null;
    const pendingPreviews = {}; // tool_use_id -> {tool_name, input}
    const pendingDrafts = new Set(); // tool_use_id awaiting draft payload
    let seenQuestionSig = null;
    // Track whether the run produced a final result (assistant reply) or an
    // explicit api_error. If neither happens before the process closes, the
    // session is stuck on tool_activity — we save a synthetic marker in onDone.
    let gotResult = false;
    // Tracks whether any non-empty assistant text was streamed in this turn.
    // Closes the race where empty `data.result` could trigger the synthetic
    // closing marker even after the user already saw streamed text.
    let _assistantTextEmittedThisTurn = false;
    // Set if the model returned a "currently unavailable" api_error and we
    // should swap session.model and retry once in onDone. Deferred (not
    // retried inline) so the previous claude proc fully closes first and we
    // don't race two concurrent --resume runs against the same session.
    let _fallbackModelTo = null;
    // Capture the run-start time so the post-run reconciliation pass can spot
    // any in-project files modified during this run that didn't get attribution
    // through the live tool_use stream (Python subprocess writes, async edits).
    const runStartTs = Date.now();
    const _provider = getProvider(session.model);
    session.provider = _provider;
    if (_provider === "claude") killExistingClaudeFor(session.claudeSessionId);
    const _runFn = _provider === "openai" ? runOpenAI
                 : _provider === "google" ? runGoogle
                 : runClaude;
    const _effort = session.effort || "max";
    const _runArgs = _provider === "claude"
      ? { project: session.project, prompt: fullPrompt, claudeSessionId: session.claudeSessionId, cwd, extraAllowedTools, model: session.model, sessionId: session.id, effort: _effort }
      : { prompt: fullPrompt, sessionId: session.id, model: session.model, project: session.project, effort: _effort };
    activeProc = _runFn(
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
                // Detect ```email-draft fenced blocks emitted by the
                // /draft-email skill. Parse → emit an email_draft action card
                // → strip the raw fence so it doesn't render as code-block
                // noise alongside the card (the "doubled" bug).
                let _emittedText = block.text;
                const _edRe = /```email-draft\n([\s\S]*?)\n```\s*/g;
                const _edMatches = [..._emittedText.matchAll(_edRe)];
                if (_edMatches.length) {
                  for (const _m of _edMatches) {
                    try {
                      const payload = JSON.parse(_m[1]);
                      if (payload.to && payload.subject && payload.body) {
                        const draftMsg = { type: "email_draft",
                          to: payload.to || "", cc: payload.cc || "",
                          subject: payload.subject || "", body: payload.body || "",
                          thread_id: payload.thread_id || "",
                          attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
                          project: session.project,
                          ts: Date.now() };
                        wsSend(ws, draftMsg);
                        saveMessage(session.id, { role: "email_draft",
                          to: draftMsg.to, cc: draftMsg.cc,
                          subject: draftMsg.subject, body: draftMsg.body,
                          thread_id: draftMsg.thread_id,
                          attachments: draftMsg.attachments,
                          project: draftMsg.project,
                          ts: draftMsg.ts });
                      }
                    } catch (e) {
                      console.error("[email_draft] skill-block parse failed:", e.message);
                    }
                  }
                  _emittedText = _emittedText.replace(_edRe, "").trim();
                }
                if (_emittedText) wsSend(ws, "text", { text: _emittedText });
              }
              if (block.type === "tool_use") {
                lastToolUse = { name: block.name, input: block.input, id: block.id };
                // Track file-writing tools so we auto-create previews on success
                if (["Write","Edit","MultiEdit","NotebookEdit"].includes(block.name)) {
                  pendingPreviews[block.id] = { tool_name: block.name, input: block.input };
                }
                // Track Bash so we can scan stdout for generated file paths
                if (block.name === "Bash") {
                  pendingPreviews[block.id] = { tool_name: "Bash", input: block.input };
                }
                // NOTE: previously we pinned files on Read too, but per David's model
                // the chat drawer should only contain files MADE IN this chat (Write/Edit
                // outputs, voice notes recorded here). Reading a file for context does
                // not mean it belongs to this chat — that just leaked cross-project
                // files. Pinning on Read disabled intentionally.
                // Track draft_email so we forward the result as a special message
                if (block.name === "mcp__crankhero-draft__draft_email") {
                  pendingDrafts.add(block.id);
                }
                // Persist a lightweight activity log (skip AskUserQuestion — handled separately below)
                if (block.name !== "AskUserQuestion") {
                  const summary = summarizeToolUse(block.name, block.input);
                  saveMessage(session.id, { role: "tool_activity", tool_name: block.name, summary, ts: Date.now() });
                }
                // Dedup consecutive AskUserQuestion with same input (claude sometimes emits twice)
                if (block.name === "AskUserQuestion") {
                  // Signature = list of question headers (model sometimes rewords but keeps structure)
                  const qs = block.input?.questions || [];
                  const sig = Array.isArray(qs) ? qs.map(q => (q.header||"")).join("|") : JSON.stringify(block.input);
                  if (sig && sig === seenQuestionSig) {
                    console.log("[dedup] skipping duplicate AskUserQuestion (same headers:", sig + ")");
                    continue;
                  }
                  seenQuestionSig = sig;
                }
                wsSend(ws, "tool_use", { name: block.name, input: block.input });
                if (block.name === "AskUserQuestion") {
                  const qText = block.input?.question || block.input?.text || JSON.stringify(block.input);
                  saveMessage(session.id, { role: "question", text: qText, ts: Date.now() });
                }
              }
            }
          }
        }
        // Process tool_results: detect permission denials AND fire auto-previews
        if (data.type === "user" && data.message?.content) {
          const content = Array.isArray(data.message.content) ? data.message.content : [];
          for (const block of content) {
            // Auto-preview: Write/Edit → autoCreatePreview; Bash → scan stdout for file paths
            if (block.type === "tool_result" && block.tool_use_id && pendingPreviews[block.tool_use_id]) {
              const pending = pendingPreviews[block.tool_use_id];
              delete pendingPreviews[block.tool_use_id];
              if (!block.is_error) {
                if (pending.tool_name === "Bash") {
                  const stdout = Array.isArray(block.content) ? (block.content[0]?.text || "") : String(block.content || "");
                  const projCwd = path.join(PROJECTS_DIR, session.project);
                  autoDetectBashFiles(stdout, session.id, projCwd);
                  // ALSO scan the Bash command string itself for files this command created.
                  // Catches `curl -s ... > path.mp3`, `curl -o path`, `cp x y`, `ffmpeg ... out.mp3`
                  // patterns where the file path never appears in stdout (silent or piped writes).
                  const cmd = pending.input?.command || "";
                  if (cmd) autoDetectBashFiles(cmd, session.id, projCwd);
                } else {
                  autoCreatePreview(pending, session.id);
                  // Robust attribution: write to the sidecar log immediately. Independent of
                  // autoCreatePreview's HTTP roundtrip to nh-backend (which can fail silently).
                  if (pending.input?.file_path) {
                    logFileAttribution(pending.input.file_path, session.id, pending.tool_name);
                  }
                }
              }
            }
            // Also scan EVERY tool_result text for project-dir file paths — catches
            // playwright:browser_take_screenshot, Read on a generated file, etc.
            // Even untracked tool_use ids land here.
            if (block.type === "tool_result" && !block.is_error) {
              try {
                const txt = Array.isArray(block.content) ? (block.content[0]?.text || "") : String(block.content || "");
                if (txt && /\/home\/claude-user\/projects\//.test(txt)) {
                  autoDetectBashFiles(txt, session.id, path.join(PROJECTS_DIR, session.project));
                }
              } catch {}
              // Sentinel for the original if (don't re-process the close brace below)
              const _scanned = true;
            }
            // Email draft: forward structured payload to client as a special message
            if (block.type === "tool_result" && block.tool_use_id && pendingDrafts.has(block.tool_use_id)) {
              pendingDrafts.delete(block.tool_use_id);
              if (!block.is_error) {
                let raw = block.content;
                if (Array.isArray(raw)) raw = (raw[0] && raw[0].text) || "";
                try {
                  const payload = JSON.parse(raw);
                  if (payload && payload.type === "email_draft") {
                    const draftMsg = { type: "email_draft",
                      to: payload.to || "", cc: payload.cc || "",
                      subject: payload.subject || "", body: payload.body || "",
                      thread_id: payload.thread_id || "",
                      attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
                      project: session.project,
                      ts: Date.now() };
                    wsSend(ws, draftMsg);
                    saveMessage(session.id, { role: "email_draft",
                      to: draftMsg.to, cc: draftMsg.cc,
                      subject: draftMsg.subject, body: draftMsg.body,
                      thread_id: draftMsg.thread_id,
                      attachments: draftMsg.attachments,
                      project: draftMsg.project,
                      ts: draftMsg.ts });
                  }
                } catch (e) {
                  console.error("[email_draft] parse failed:", e.message);
                }
              }
            }
            if (block.type === "tool_result" && block.is_error &&
                typeof block.content === "string" &&
                (block.content.includes("requested permissions") || block.content.includes("requires approval"))) {
              wsSend(ws, "permission_denied", {
                tool_use_id: block.tool_use_id,
                message: block.content,
                tool_name: lastToolUse?.name || "unknown",
                tool_input: lastToolUse?.input || {},
              });
              saveMessage(session.id, {
                role: "permission_denied",
                tool_name: lastToolUse?.name || "unknown",
                tool_input: lastToolUse?.input || {},
                message: block.content,
                ts: Date.now(),
              });
            }
          }
        }
        if (data.type === "tool_result") {
          wsSend(ws, "tool_result", { name: data.tool_name || "", content: data.content || "" });
        }
        if (data.type === "result") {
          // After clearing activeProc below, try to drain the next queued prompt
          setTimeout(() => { try { tryDrainQueue(session.id); } catch (e) { console.error("[queue] drain after result failed:", e.message); } }, 50);
          // Fire-and-forget observer: read recent messages, identify unaddressed asks, register as tasks
          // [observer] disabled 2026-05-28: was enqueueing duplicate Opus tasks
          // into orchestratorHero queue with 0% PR-ship rate. Re-enable when
          // the supervisor is redesigned to output reviewable diffs/PRs.
          // setTimeout(() => { try { spawnObserver(session.id, session.project); } catch (e) { console.error("[observer] hook failed:", e.message); } }, 500);
          setTimeout(() => { try { spawnDecisionExtractor(session.id, session.project); } catch (e) { console.error("[decision-extractor] hook failed:", e.message); } }, 800);
          setTimeout(() => { try { spawnContractCheck(session.id, session.project); } catch (e) { console.error("[contract-check] hook failed:", e.message); } }, 1100);
          // File-attribution reconcile — runs FAST (synchronous filesystem walk),
          // fires immediately so unattributed files from this run get linked before
          // the user opens the drawer.
          try { reconcileFileAttribution(session.id, session.project, runStartTs); } catch (e) { console.error("[file-reconcile] hook failed:", e.message); }
          if (!session.claudeSessionId && data.session_id) {
            session.claudeSessionId = data.session_id;
            updateSessionInStore(session);
          }
          // Detect Anthropic API errors. Two shapes:
          //  - Legacy: result text starts with "API Error: NNN ..."
          //  - Modern (e.g. image dimension limit): CLI sets data.is_error=true
          //    even though subtype is "success"; the rejection text lives in result.
          //  Either way, do NOT save as an assistant message — would poison resume.
          const result = data.result || "";
          const apiErrorMatch = /API Error:\s*(\d{3})\b[\s\S]*?(request_id"\s*:\s*"([^"]+)")?/.exec(result);
          const isApiError = data.is_error === true || /^API Error:\s*\d{3}/.test(result);
          gotResult = true;
          if (isApiError) {
            const statusCode = apiErrorMatch ? apiErrorMatch[1] : "";
            const requestId = apiErrorMatch ? (apiErrorMatch[3] || "") : "";
            // Model-unavailable detection: Anthropic returns a friendly
            // "<Model> is currently unavailable" line for access-gated
            // models (e.g. Fable 5 during Mythos staged rollout). When
            // that hits, falling back to opus and re-firing the user's
            // last prompt is strictly better than a silent dead chat —
            // the prior api_error path didn't persist anything, so if
            // the client's WS had already dropped the user just saw the
            // agent ghost them. Now: switch model, log a notice, retry.
            const _modelUnavailable = /is currently unavailable|mythos|access[- ]gated/i.test(result);
            const _curAlias = (session.model || "").toLowerCase();
            if (_modelUnavailable && _curAlias && _curAlias !== "opus" && !isRetry) {
              _fallbackModelTo = "opus";
              // Don't wsSend api_error — we're handling it via the
              // fallback notice + retry in onDone.
            } else {
              // Don't save as assistant — prevents polluting context on retry
              wsSend(ws, "api_error", {
                status_code: statusCode,
                request_id: requestId,
                message: result.slice(0, 500),
              });
            }
          } else {
            // Strip any ```email-draft fences from the final assistant text —
            // the card already rendered live; persisting the fence in the
            // assistant message would re-render it as raw code on reload.
            let _resultClean = result.replace(/```email-draft\n[\s\S]*?\n```\s*/g, "").trim();
            if (_resultClean) {
              saveMessage(session.id, { role: "assistant", text: _resultClean, ts: Date.now(), cost: data.total_cost_usd, duration: data.duration_ms });
              // Title on the first exchange, then refresh every ~3 user turns so a
              // drifting/pivoting session keeps a sidebar title that reflects its
              // current topic. generateSessionTitle builds its own recent context.
              try {
                const _allSessions = loadSessions();
                const _s = _allSessions.find(x => x.id === session.id);
                if (_s) {
                  const _userMsgs = loadMessages(session.id).filter(m => m.role === "user").length;
                  const _firstTitle = !_s.titleGenerated && _userMsgs >= 1;
                  const _refresh = _s.titleGenerated && (_userMsgs - (_s.titleUserMsgs || 0)) >= 3;
                  if (_firstTitle || _refresh) generateSessionTitle(session.id);
                }
              } catch (e) { console.warn("[title-gen] trigger failed:", e.message); }
            } else if (result) {
              // The whole turn was just the email-draft fence — no other text.
              // Don't save an empty assistant message, but the closing-bubble
              // synthetic-marker logic below will surface "(draft above)".
            }
            if (lastToolUse && !_assistantTextEmittedThisTurn) {
              // Tools fired but the model returned no closing text AND no
              // streamed assistant text either. Surface a marker so the UI
              // never ends silently on tool_activity. Guarded against the
              // race where text was streamed but the final `result` field
              // arrived empty or trailing-whitespace-only.
              saveMessage(session.id, {
                role: "assistant",
                text: "_(Agent finished its tool work without a written summary. Re-prompt if you want it to recap or continue.)_",
                ts: Date.now(),
                cost: data.total_cost_usd,
                duration: data.duration_ms,
                synthetic: "empty-result-after-tools",
              });
            }
            wsSend(ws, "done", {
              result,
              cost: data.total_cost_usd,
              duration: data.duration_ms,
              session_id: data.session_id,
            });
          }
        }
      },
      (code, stderr) => {
        activeProc = null;
        activeProcBySession.delete(session.id); // run finished — session is idle again
        // Model-unavailable fallback: api_error said the model is gated.
        // Persist a visible notice (so the chat never goes silently dead
        // again even if WS is gone), flip session.model to opus, and
        // re-fire the user's last text exactly once. Guard with isRetry
        // so opus failing doesn't cause an infinite loop.
        if (_fallbackModelTo && !isRetry) {
          const _fromAlias = session.model || "?";
          const _toAlias = _fallbackModelTo;
          _fallbackModelTo = null;
          saveMessage(session.id, {
            role: "assistant",
            text: "_⚠️ Model `" + _fromAlias + "` is currently unavailable — falling back to `" + _toAlias + "` and retrying._",
            ts: Date.now(),
            synthetic: "model-fallback",
          });
          session.model = _toAlias;
          updateSessionInStore(session);
          wsSend(ws, "history", { messages: loadMessages(session.id) });
          const msgs0 = loadMessages(session.id);
          const lu = [...msgs0].reverse().find(m => m.role === "user");
          if (lu) {
            console.log("[model-fallback]", session.id, _fromAlias, "->", _toAlias);
            wsSend(ws, "thinking");
            sendToSession(lu.text, true);
            return;
          }
        }
        // Detect a stale claudeSessionId — happens after we move a session
        // between projects (claude's per-project state dir doesn't move with
        // sessions.json). Clear and retry fresh, exactly once.
        if (code !== 0 && stderr && /No conversation found with session ID/.test(stderr) && session.claudeSessionId) {
          console.log("[stale-resume] clearing claudeSessionId for", session.id);
          session.claudeSessionId = null;
          updateSessionInStore(session);
          if (!isRetry) {
            const msgs0 = loadMessages(session.id);
            const lu = [...msgs0].reverse().find(m => m.role === "user");
            if (lu) {
              wsSend(ws, "thinking");
              sendToSession(lu.text, true);
              return;
            }
          }
        }
        const msgs = loadMessages(session.id);
        // Auto-retry when the process exited without a result and the last user
        // message has no real assistant response after it — including the case
        // where the only thing after is tool_activity rows and a stalled marker.
        if (!isRetry && !gotResult) {
          let lui = -1;
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "user") { lui = i; break; }
          }
          if (lui >= 0) {
            const after = msgs.slice(lui + 1);
            const answered = after.some(m => m.role === "assistant" && !m.stalled);
            if (!answered) {
              console.log("[auto-retry] response lost, retrying:", session.id);
              wsSend(ws, "thinking");
              sendToSession(msgs[lui].text, true);
              return;
            }
          }
        }
        if (code !== 0 && stderr) {
          wsSend(ws, "error", { message: stderr.slice(0, 500) });
        }
        // Stalled-run guard: process closed but no result/api_error ever came.
        // Save a synthetic marker so the persisted state isn't stuck on
        // tool_activity forever (which makes the sidebar show "working").
        if (!gotResult) {
          const msgs2 = loadMessages(session.id);
          const last = msgs2.length ? msgs2[msgs2.length - 1] : null;
          const stuckRoles = new Set(["tool_activity", "tool_result", "permission_granted"]);
          if (last && stuckRoles.has(last.role)) {
            const note = code === 0
              ? "⚠️ The agent stopped mid-run without producing a final response. Re-prompt to continue."
              : "⚠️ The agent process exited (code " + code + ") before producing a final response. Re-prompt to retry.";
            saveMessage(session.id, { role: "assistant", text: note, ts: Date.now(), recovered: true, stalled: true });
            wsSend(ws, "history", { messages: loadMessages(session.id) });
            console.log("[stalled-run]", session.id, "no result; saved marker (code=" + code + ")");
          }
        }
        wsSend(ws, "idle");
        // Authoritative idle point: the run's process has fully exited and the
        // session is no longer busy. Drain the next queued prompt now. This is the
        // RELIABLE trigger — the result-stream drain (search "drain the next queued
        // prompt") no-ops when the WS dropped mid-turn (common on mobile), since no
        // live client exists at that instant and nothing re-attempts from completion.
        setTimeout(() => { try { tryDrainQueue(session.id); } catch (e) { console.error("[queue] drain after close failed:", e.message); } }, 50);
      }
    );
    // Register session-level busy state so a reconnected WS (or a queued-item drain)
    // sees this session as busy until the onDone above fires, regardless of which WS
    // owns the proc. _runFn returns the child synchronously.
    if (activeProc) activeProcBySession.set(session.id, activeProc);
  }

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    switch (msg.type) {
      case "prompt": {
        // ACK immediately so client can drop from outbox even if we reject below
        if (msg.client_id) {
          wsSend(ws, "ack", { client_id: msg.client_id });
        }
        // Dedupe resends: if we already saved this client_id as a user message, skip
        if (msg.resend && msg.client_id) {
          const existing = loadMessages(session.id);
          if (existing.some(m => m.role === "user" && m.client_id === msg.client_id)) {
            console.log("[outbox] resend already processed, skipping:", msg.client_id);
            return;
          }
        }
        // Process images UP FRONT so the queue (if we queue) carries the augmented
        // prompt — otherwise queued prompts would silently drop their images on drain.
        const text = (msg.text || "").trim();
        const images = Array.isArray(msg.images) ? msg.images : [];
        const imagePaths = [];
        for (const img of images) {
          if (img.data) {
            const p = saveUploadedImage(img.data, img.mimeType);
            imagePaths.push(p);
          }
        }
        let prompt = text;
        if (imagePaths.length > 0) {
          const imageRefs = imagePaths.map((p, i) => `[Image ${i + 1}: ${p}]`).join(" ");
          prompt = `${text}\n\nThe user attached ${imagePaths.length} image(s). Read them with the Read tool to see them: ${imageRefs}`;
        }
        const _source = msg.source || "prompt";
        const _audioUrl = msg.audioUrl || null;

        if (activeProc || activeProcBySession.has(session.id)) {
          // Already running (on this WS, or on another WS for the same session
          // after a mobile reconnect) — write the new prompt to the persistent
          // queue. It will auto-fire when the current run completes (see onDone).
          // Carry promptText (image-augmented) so drain fires the right text to
          // Claude; text (the user's actual words) is what we persist + display.
          queueAppend(session.id, {
            text: text || "",
            promptText: prompt,
            source: _source,
            audioUrl: _audioUrl,
            hasImages: imagePaths.length > 0,
            client_id: msg.client_id
          });
          wsSend(ws, "queued", { client_id: msg.client_id, queueDepth: queueLoad(session.id).length });
          // Broadcast new queue contents to every connected client on this session so
          // other tabs/devices see the pending bubble too.
          broadcastQueueState(session.id);
          return;
        }

        if (!text) return;

        session.messageCount++;
        if (session.messageCount === 1) session.title = text.slice(0, 80);
        session.lastActive = Date.now();
        // V1.2: Clear manualDone on follow-up so the session resurfaces in the
        // sidebar instead of staying hidden in the "done" pile.
        if (session.manualDone) {
          session.manualDone = null;
          delete session.doneSource;
        }
        // V1.1: Flag as awaiting response so the sidebar shows "user_waiting"
        // until the agent produces a reply. Cleared in saveMessage when an
        // assistant/tool_activity message arrives.
        session.awaitingResponse = true;
        // First substantive action — promote a pending session to disk now.
        _persistSessionIfNew(session);
        updateSessionInStore(session);

        // Save user message
        saveMessage(session.id, { role: "user", text, ts: Date.now(), client_id: msg.client_id, hasImages: imagePaths.length > 0, source: _source, audioUrl: _audioUrl });

        ws.send(JSON.stringify({ type: "thinking" }));

        sendToSession(prompt, false);
        break;
      }
      case "load_more": {
        const all = loadMessages(session.id);
        const before = msg.before || all.length;
        const count = msg.count || 20;
        const start = Math.max(0, before - count);
        const slice = all.slice(start, before);
        ws.send(JSON.stringify({ type: "history_prepend", messages: slice, offset: start, total: all.length }));
        break;
      }
      case "set_model": {
        const m = String((msg && msg.model) || "").trim();
        const ALLOWED = /^[a-z][a-z0-9.-]{0,80}$/;
        if (m && !ALLOWED.test(m)) {
          wsSend(ws, "error", { message: "Invalid model name" });
          break;
        }
        session.model = m || null;
        session.provider = getProvider(m);
        updateSessionInStore(session);
        wsSend(ws, "model_set", { model: session.model, provider: session.provider });
        console.log("[model] session", session.id, "->", session.model || "default", "("+session.provider+")");
        break;
      }
      case "set_effort": {
        const e = String((msg && msg.effort) || "").trim().toLowerCase();
        const ALLOWED_EFFORT = new Set(["low", "medium", "high", "max"]);
        if (e && !ALLOWED_EFFORT.has(e)) {
          wsSend(ws, "error", { message: "Invalid effort level" });
          break;
        }
        session.effort = e || "max";
        updateSessionInStore(session);
        wsSend(ws, "effort_set", { effort: session.effort });
        console.log("[effort] session", session.id, "->", session.effort);
        break;
      }
      case "link_task": {
        const taskId = String(msg.task_id || "").trim();
        session.linked_task = taskId || null;
        updateSessionInStore(session);
        wsSend(ws, "task_linked", { task_id: session.linked_task });
        console.log("[task-link] session", session.id, "->", session.linked_task || "none");
        break;
      }
      case "permission_grant": {
        // Add permission to session's allowlist for future spawns
        ensurePermissionsLoaded(session.id);
        const perm = msg.permission; // e.g. "Write", "Edit", "Bash(npm:*)"
        if (perm) {
          sessionPermissions[session.id].add(perm);
          savePermissions(session.id);
          console.log("[permission] granted for session", session.id, ":", perm);
          wsSend(ws, "permission_granted", { permission: perm });

          // Auto-retry: re-send the last user message with the new permission.
          // If activeProc is somehow still alive (race between permission_denied
          // and grant arrival), kill it first — that process was about to die
          // from the perm error anyway. Previously this branch silently skipped
          // the retry, which is what users hit as "shit never works when I give
          // permission".
          if (msg.autoRetry !== false) {
            if (activeProc) {
              try { activeProc.kill("SIGINT"); } catch {}
              activeProc = null;
            }
            const msgs = loadMessages(session.id);
            let lastUserText = null;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "user") { lastUserText = msgs[i].text; break; }
            }
            if (lastUserText) {
              console.log("[permission] auto-retrying after grant:", session.id);
              wsSend(ws, "thinking");
              sendToSession(lastUserText, true);
            } else {
              console.warn("[permission] grant arrived but no user message to retry:", session.id);
              wsSend(ws, "error", { message: "Permission granted but couldn\u2019t find a message to retry. Send your prompt again." });
            }
          }
        }
        break;
      }
      case "pong": {
        // client is alive; nothing to do
        break;
      }
      case "get_summary": {
        const allMsgs = loadMessages(session.id);
        const userMessages = allMsgs.filter(m => m.role === "user").length;
        const questions = allMsgs.filter(m => m.role === "question").length;
        const activities = allMsgs.filter(m => m.role === "tool_activity");
        const filesWritten = [...new Set(activities.filter(a => a.tool_name === "Write").map(a => a.summary))];
        const filesEdited = [...new Set(activities.filter(a => a.tool_name === "Edit" || a.tool_name === "MultiEdit" || a.tool_name === "NotebookEdit").map(a => a.summary))];
        const filesRead = [...new Set(activities.filter(a => a.tool_name === "Read").map(a => a.summary))];
        const bashCommands = [...new Set(activities.filter(a => a.tool_name === "Bash").map(a => a.summary))];
        const mcpTools = [...new Set(activities.filter(a => a.tool_name.startsWith("mcp__")).map(a => a.tool_name.replace(/^mcp__/, "").replace(/__/g, ":")))];
        let startedAt = null, lastActive = null;
        if (allMsgs.length) {
          startedAt = allMsgs[0].ts || null;
          lastActive = allMsgs[allMsgs.length - 1].ts || null;
        }
        const durationSec = (startedAt && lastActive) ? Math.round((lastActive - startedAt) / 1000) : 0;
        const totalCost = allMsgs.filter(m => typeof m.cost === "number").reduce((a, m) => a + m.cost, 0);
        wsSend(ws, "session_summary", {
          data: {
            user_messages: userMessages,
            questions,
            files_written: filesWritten,
            files_edited: filesEdited,
            files_read: filesRead,
            bash_commands: bashCommands,
            mcp_tools: mcpTools,
            duration_seconds: durationSec,
            total_cost_usd: totalCost,
            started_at: startedAt,
            last_active: lastActive,
          },
        });
        break;
      }
      case "interrupt": {
        if (activeProc) {
          console.log("[interrupt] killing active claude for session", session.id);
          const _p = activeProc;
          activeProc = null;
          try { process.kill(-_p.pid, "SIGINT"); } catch { try { _p.kill("SIGINT"); } catch {} }
          setTimeout(() => { try { process.kill(-_p.pid, "SIGKILL"); } catch { try { _p.kill("SIGKILL"); } catch {} } }, 2000);
          saveMessage(session.id, { role: "interrupted", ts: Date.now() });
        }
        wsSend(ws, "interrupted");
        break;
      }
      case "delete_message": {
        // Delete a user message (and the assistant reply / tool blocks that
        // belong to that turn). If the message is still queued, drop it from
        // the queue. If it's the in-flight prompt, kill the active run first.
        // After the delete, broadcast a fresh `history` to all clients on this
        // session so every tab/device re-renders with the canonical state.
        const cid = String((msg && msg.client_id) || "").trim();
        if (!cid) { wsSend(ws, "error", { message: "delete_message requires client_id" }); break; }

        // 1) Queued? Pop it and we're done.
        const q = queueLoad(session.id);
        const qIdx = q.findIndex(it => it && it.client_id === cid);
        if (qIdx >= 0) {
          q.splice(qIdx, 1);
          queueSaveAll(session.id, q);
          broadcastQueueState(session.id);
          broadcastToSession(session.id, { type: "messages_deleted", client_ids: [cid] });
          console.log("[delete] queued prompt removed", session.id, cid);
          break;
        }

        // 2) Find the user message in saved history.
        const all = loadMessages(session.id);
        const idx = all.findIndex(m => m && m.role === "user" && m.client_id === cid);
        if (idx < 0) {
          // Already gone server-side — tell the client to drop its bubble anyway.
          broadcastToSession(session.id, { type: "messages_deleted", client_ids: [cid] });
          break;
        }

        // 3) The "turn" is this user msg + every non-user msg up to the next user msg.
        let endExclusive = all.length;
        for (let i = idx + 1; i < all.length; i++) {
          if (all[i] && all[i].role === "user") { endExclusive = i; break; }
        }
        const turn = all.slice(idx, endExclusive);
        const tsList = turn.map(m => m.ts).filter(t => Number.isFinite(t));

        // 4) If this is the most recent user msg and the agent is running, kill it.
        const isLastUser = idx === all.map(m => m.role).lastIndexOf("user");
        const liveProc = activeProc || activeProcBySession.get(session.id);
        if (isLastUser && liveProc) {
          console.log("[delete] killing in-flight agent for", session.id, cid);
          if (activeProc === liveProc) activeProc = null;
          activeProcBySession.delete(session.id);
          try { process.kill(-liveProc.pid, "SIGINT"); } catch { try { liveProc.kill("SIGINT"); } catch {} }
          const _p = liveProc;
          setTimeout(() => { try { process.kill(-_p.pid, "SIGKILL"); } catch { try { _p.kill("SIGKILL"); } catch {} } }, 2000);
        }

        // 5) Delete from store.
        const removed = deleteMessagesByTs(session.id, tsList);
        console.log("[delete] removed", removed, "of", tsList.length, "msgs for", session.id, cid);

        // 6) Broadcast fresh history so all clients re-render the canonical state.
        broadcastToSession(session.id, { type: "history", messages: loadMessages(session.id), offset: 0 });
        break;
      }
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    revokeNoncesForWs(ws);
    // Don't kill the process on disconnect - let it finish
    console.log("Client disconnected:", session.id);
  });

  console.log("Client connected:", session.project, session.id);
});
}

module.exports = { registerWsHandlers };

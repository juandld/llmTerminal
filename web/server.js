const express = require("express");
const { WebSocketServer } = require("ws");
const mcpDiscover = require("./src/mcp/discover");
const mcpTranslate = require("./src/mcp/translate");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const { setWss, wsSend, findSessionOr404, broadcastToSession } = require("./src/ws/broadcast");
setWss(wss);

app.use(express.json());

// Force revalidation of JS/CSS so mobile browsers don't serve stale code
app.use((req, res, next) => {
  if (/\.(js|css|html)$/.test(req.path)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});


// Path-based cache busting: rewrites styles.css → _bust/<mtime>-<now>/styles.css
// CDNs can strip query strings but never strip path segments, so this always works.
function rewriteCacheBust(html, publicDir) {
  return html.replace(
    /(<(?:script|link)[^>]*?(?:src|href)=")([^"?]+\.(?:js|css))(")/g,
    (m, pre, file, post) => {
      try {
        const st = fs.statSync(path.join(publicDir, file));
        return pre + "_bust/" + Math.floor(st.mtimeMs) + "-" + Date.now() + "/" + file + post;
      } catch { return m; }
    }
  );
}
app.get("/_bust/:hash/*", (req, res, next) => {
  const file = req.params[0];
  res.sendFile(path.join(__dirname, "public", file), (err) => { if (err) next(); });
});
app.get("/", (req, res) => {
  const pubDir = path.join(__dirname, "public");
  const idx = path.join(pubDir, "index.html");
  try {
    const html = fs.readFileSync(idx, "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(rewriteCacheBust(html, pubDir));
  } catch (e) {
    res.status(500).send("index error: " + e.message);
  }
});

app.use(express.static(path.join(__dirname, "public"), { etag: false, lastModified: false }));

const { PROJECTS_DIR, DATA_DIR } = require("./src/paths");
const {
  db, loadMessages, saveMessage, updateMessageByTs, deleteMessages, ensureProjectTrusted,
  loadSessions, saveSessions, updateSessionInStore, _persistSessionIfNew,
} = require("./src/store");

// Send a JSON payload to a single WebSocket, swallowing errors (client may have disconnected).
// ---- Image uploads ----
const { activeProcs, activeProcBySession } = require("./src/proc-state");
const deferredRestart = require("./src/deferred-restart");
const { runOpenAI } = require("./src/providers/openai");
const { runGoogle } = require("./src/providers/google");
const { getProvider } = require("./src/providers/context");
const { saveUploadedImage } = require("./src/uploads");
// ---- Startup recovery: fix any sessions stuck from before restart ----
// Unions the shutdown snapshot (sessions whose run was SIGKILLed by the last
// restart — loop-hardening WS1b) with the unanswered scan. The scan logic
// (last-user-message answered-ness guard + freshness skip) lives in
// shutdown-snapshot.js:recoveryCandidate so the shutdown/boot pair is testable.
const shutdownSnap = require("./src/shutdown-snapshot");
setTimeout(() => {
  const killedMidRun = shutdownSnap.consumeSnapshot(); // Set — read-once, deleted on consume
  const sessions = loadSessions();
  for (const session of sessions) {
    // delete() = union with the scan: each snapshot id is handled exactly once,
    // leftovers (session record gone) are reported after the loop.
    const wasKilledMidRun = killedMidRun.delete(session.id);
    const msgs = loadMessages(session.id);
    if (!msgs.length) continue;
    const cand = shutdownSnap.recoveryCandidate(msgs, { wasKilledMidRun });
    if (!cand.recover) {
      if (wasKilledMidRun) console.log("[startup-recovery] snapshot session skipped (" + cand.why + "):", session.id);
      continue;
    }
    const lastUserMsg = msgs[cand.lastUserIdx];
    // A session with a scheduled wake (due or future) belongs to the wake
    // sweeper — its wakePrompt is the precise continuation. Re-firing the
    // original user prompt here would double-run the turn. Snapshot sessions
    // included: a killed run whose wake survived (pending-wakeups.json) resumes
    // via the wake, not via a duplicate re-fire of the old prompt.
    const _regEntry = require("./src/run-registry").getEntry(session.id);
    if (_regEntry && _regEntry.wakeAt) { console.log("[startup-recovery] skipping (pending wake):", session.id); continue; }

    // Governor gate (WS3a): startup-recovery re-fires are machine-initiated.
    // Parked sessions stay recoverable — David re-prompting is never gated.
    const _gv = require("./src/governor").check("llmterminal-auto");
    if (!_gv.ok) { console.log("[governor] parked startup-recovery re-fire:", session.id, "—", _gv.reason); continue; }

    console.log("[startup-recovery] retrying stuck session:", session.id, "(" + cand.why + ")");
    const cwd = path.join(PROJECTS_DIR, session.project);
    ensurePermissionsLoaded(session.id);
    const perms = sessionPermissions[session.id];
    // Route by provider — a gpt-5.x/o-series/gemini session must NOT be resumed
    // through the Claude CLI (which rejects non-Claude models with "you may not
    // have access to it"). Mirrors the routing in ws/connection.js.
    const _provider = getProvider(session.model);
    const _runFn = _provider === "openai" ? runOpenAI : _provider === "google" ? runGoogle : runClaude;
    if (_provider === "claude") killExistingClaudeFor(session.claudeSessionId);
    const _runArgs = _provider === "claude"
      ? { project: session.project, prompt: lastUserMsg.text, claudeSessionId: session.claudeSessionId, cwd, extraAllowedTools: perms ? [...perms] : [], model: session.model, sessionId: session.id, effort: session.effort, governorComponent: "llmterminal-auto", spawnTrigger: "recovery" }
      : { prompt: lastUserMsg.text, sessionId: session.id, model: session.model, project: session.project, effort: session.effort };
    _runFn(
      _runArgs,
      (data) => {
        if (data.type === "system" && data.subtype === "init" && data.session_id && !session.claudeSessionId) {
          session.claudeSessionId = data.session_id;
          updateSessionInStore(session);
        }
        if (data.type === "result" && data.result) {
          // Skip api_error results — saving them poisons resume forever.
          if (data.is_error === true || /^API Error:\s*\d{3}/.test(data.result)) {
            console.log("[startup-recovery] api_error, skipping save:", session.id, data.result.slice(0,120));
          } else {
            saveMessage(session.id, { role: "assistant", text: data.result, ts: Date.now(), recovered: true });
            console.log("[startup-recovery] recovered:", session.id);
            broadcastToSession(session.id, { type: "history", messages: loadMessages(session.id) });
          }
        }
      },
      (code) => { if (code !== 0) console.log("[startup-recovery] failed:", session.id, "code:", code); }
    );
  }
  // Snapshot ids with no session record left — nothing to re-fire, but say so:
  // silent drops are how the 16:59 non-recovery went undiagnosed for a day.
  for (const id of killedMidRun) console.log("[startup-recovery] snapshot session not in store, dropped:", id);
}, 5000);

// ---- Periodic stalled-session janitor (signal-based, 2026-07-04) ----
// Still the ONE canonical stuck-checker (isolation invariant #4), but verdicts
// now come from run-registry signals — pid liveness, stream bytes, open-tool
// budgets, cpu+io deltas, pending wakes — instead of message age. Only two
// states ever get the ⚠️ marker, both provable:
//   wedged       — pid alive but no stream, no open tool within budget, and
//                  cpu+io flat across two consecutive sweeps (~10 min apart)
//   dead_mid_run — proc gone mid-tool, no result saved, no pending wake
// Thinking silences, long subagents, paused loops, and sleeping phones are all
// "working"/"paused" and left alone. The old STALLED_AGE_THRESHOLD_MS and the
// wss.clients liveness set (which went empty whenever the phone backgrounded,
// defaming healthy runs) are gone; see LIVENESS-AND-FRUITION-PLAN-2026-07-04.md.
const runReg = require("./src/run-registry");
const runLedger = require("./src/run-ledger");
runReg.loadRegistry(); // adopt/bury persisted entries before any timer fires
const STALLED_SWEEP_INTERVAL_MS = 5 * 60 * 1000;   // every 5 min
const _STALLED_STUCK_ROLES = new Set(["tool_activity", "tool_result", "permission_granted"]);

function sweepStalledSessions() {
  try {
    const sessions = loadSessions();
    if (!sessions || !sessions.length) return;
    const now = Date.now();
    let marked = 0;
    for (const s of sessions) {
      const msgs = loadMessages(s.id);
      if (!msgs.length) continue;
      const last = msgs[msgs.length - 1];
      if (!last || !_STALLED_STUCK_ROLES.has(last.role)) continue;
      runReg.sampleForWedge(s.id); // advance cpu/io evidence for live-but-silent procs
      const v = runReg.sessionRunState(s.id, { lastMessageRole: last.role, lastActiveTs: last.ts || s.lastActive });
      if (v.state === "wedged") {
        const e = runReg.getEntry(s.id);
        try { if (e && e.pid) process.kill(e.pid, "SIGTERM"); } catch {}
        // Run-ledger L4 evidence (additive): last ledger event + age + pid
        // liveness in the SAME line as the verdict, so a contradiction
        // ("heartbeat 12s ago, pid ALIVE") is visible where the decision logs.
        console.log("[stalled-sweep] wedged (cpu+io flat 2 sweeps), SIGTERM:", s.id, "pid:", e && e.pid, "—", runLedger.evidence(s.id));
        if (e && e.adopted) {
          // Adopted orphans have no close handler — write the marker ourselves.
          // For this-server procs the SIGTERM triggers onClose, which writes
          // the canonical "exited before final response" marker; no double.
          const note = "⚠️ The agent process wedged (no CPU/io activity across two sweeps) and was terminated. Re-prompt to continue.";
          saveMessage(s.id, { role: "assistant", text: note, ts: now, recovered: true, stalled: true });
          try { broadcastToSession(s.id, { type: "history", messages: loadMessages(s.id) }); } catch {}
          marked++;
        }
      } else if (v.state === "dead_mid_run") {
        const note = "⚠️ The agent process died mid-run without a final response. Re-prompt to continue.";
        saveMessage(s.id, { role: "assistant", text: note, ts: now, recovered: true, stalled: true });
        try { broadcastToSession(s.id, { type: "history", messages: loadMessages(s.id) }); } catch {}
        console.log("[stalled-sweep] dead mid-run, marked:", s.id, v.legacy ? "(legacy-age fallback)" : "(pid " + v.pid + ", exit " + v.exitCode + ")", "—", runLedger.evidence(s.id));
        // Dead-run auto-continuation (call-for-David B): same revive/cap logic
        // as the in-proc onClose hook, for deaths only the sweep can see
        // (procs SIGKILLed with the server, orphans with no close handler).
        try { require("./src/attention").handleDeadRun(s.id, { claudeSessionId: s.claudeSessionId, exitCode: v.exitCode, cause: "stalled" }); }
        catch (e) { console.warn("[auto-continue] sweep hook failed:", e.message); }
        marked++;
      }
      // working / waiting_tool / paused_until / awaiting_user / idle → leave alone
    }
    if (marked > 0) console.log("[stalled-sweep] marked", marked, "stalled session(s)");
  } catch (e) {
    console.error("[stalled-sweep] error:", e.message);
  }
}

setTimeout(sweepStalledSessions, 60 * 1000); // first sweep 60s after boot (after startup-recovery has run)
setInterval(sweepStalledSessions, STALLED_SWEEP_INTERVAL_MS).unref();

// ---- Scheduled-wake re-firing (LIVENESS plan Phase 2) ----
// ScheduleWakeup ends the turn and the CLI process exits with it — without this
// loop, every /loop iteration parked >5 min simply never continued (bc590843's
// overnight failure). The registry persists {wakeAt, wakePrompt} parsed from the
// tool_use; when a wake is due and the session has no live run, we push the
// wake prompt through the NORMAL queue machinery (queueAppend + tryDrainQueue →
// fireQueueHeadless), which gives the full pipeline: user message with
// source:"wake", tool activity rows, previews, supervisors, queue serialization.
const WAKE_SWEEP_INTERVAL_MS = 30 * 1000;
function sweepDueWakes() {
  try {
    const due = runReg.dueWakes(Date.now());
    if (!due.length) return;
    const throttle = require("./src/throttle");
    for (const e of due) {
      if (activeProcBySession.has(e.sessionId)) continue; // run still live; re-check next sweep
      const session = loadSessions().find(s => s.id === e.sessionId);
      if (!session) { runReg.clearWake(e.sessionId, "lost (session record gone)"); continue; }
      if (getProvider(session.model) !== "claude") { runReg.clearWake(e.sessionId, "lost (non-claude provider)"); continue; } // harness tool: claude-only
      if (throttle.remaining() > 0) {
        console.log("[wake-sweep] throttled, deferring wake for", e.sessionId.slice(0, 8), "(" + Math.round(throttle.remaining() / 1000) + "s left)");
        continue; // retry next sweep — wakeAt stays set
      }
      // Governor gate (WS3a): wake re-fires are machine-initiated — the exact
      // path that leaked overnight 2026-07-03. Defer (wake stays armed), never
      // drop: the wake fires as soon as the cap window rolls or cooldown ends.
      const _gv = require("./src/governor").check("llmterminal-auto");
      if (!_gv.ok) {
        console.log("[governor] parked wake re-fire for", e.sessionId.slice(0, 8), "—", _gv.reason);
        continue; // retry next sweep — wakeAt stays set
      }
      const overdueMs = Date.now() - e.wakeAt;
      const overdueMin = Math.round(overdueMs / 60000);
      // Late = re-armed past-due at boot (server was down when it should have
      // fired) or overdue past the sweep's own cadence — the model should know
      // the gap exists rather than assume its requested delay was honored.
      const late = !!e.wakeLate || overdueMs > 2 * 60 * 1000;
      let prompt = e.wakePrompt ||
        ("Scheduled wake-up fired (reason: " + (e.wakeReason || "unspecified") + "). Continue the task you scheduled this wake for; if it is complete, say so and do not schedule another wake.");
      if (late) {
        prompt = "[Late wake-up: this was scheduled to fire at " + new Date(e.wakeAt).toISOString() +
          " and is firing ~" + Math.max(1, overdueMin) + " min late (server restart or timer delay). Account for the gap before continuing.]\n\n" + prompt;
      }
      runReg.clearWake(e.sessionId, late ? "late-fired" : "fired"); // the queue item owns the continuation now
      console.log("[wake-sweep] firing wake for", e.sessionId.slice(0, 8), overdueMin > 1 ? "(" + overdueMin + "min overdue)" : "", "reason:", (e.wakeReason || "").slice(0, 60));
      queueAppend(e.sessionId, { text: prompt, source: "wake", ts: Date.now() });
      try { tryDrainQueue(e.sessionId); } catch (err) { console.error("[wake-sweep] drain failed:", err.message); }
    }
  } catch (e) {
    console.error("[wake-sweep] error:", e.message);
  }
}
setTimeout(sweepDueWakes, 30 * 1000); // first pass after startup-recovery (5s) has settled
setInterval(sweepDueWakes, WAKE_SWEEP_INTERVAL_MS).unref();

// Gmail Pub/Sub webhook + watch renewal (see src/gmail.js).
require("./src/gmail")(app);

// ---- API ----
app.get("/health", (_, res) => {
  const sessions = loadSessions();
  const run_states = {};
  for (const s of sessions) {
    const st = runReg.sessionRunState(s.id, { lastMessageRole: s.lastMessageRole, lastActiveTs: s.lastActive }).state;
    run_states[st] = (run_states[st] || 0) + 1;
  }
  res.json({
    status: "ok", sessions: sessions.length,
    stuck: (run_states.dead_mid_run || 0) + (run_states.wedged || 0),
    run_states,
    pending_wakes: runReg.dueWakes(Number.MAX_SAFE_INTEGER).length,
  });
});
app.get("/api/projects", (_, res) => {
  // Skip symlinks so legacy compat symlinks (e.g. narrativeHero -> orchestratorHero)
  // do not show up as duplicate projects in the sidebar. Real dirs only.
  const dirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
    if (d.startsWith(".")) return false;
    try {
      const st = fs.lstatSync(path.join(PROJECTS_DIR, d));
      return st.isDirectory() && !st.isSymbolicLink();
    } catch { return false; }
  });
  res.json(dirs);
});

app.get("/api/providers", (_req, res) => {
  res.json({
    claude: true,
    openai: !!process.env.OPENAI_API_KEY,
    google: !!process.env.GOOGLE_API_KEY,
  });
});

// ─── Dynamic model discovery ────────────────────────────────────────────────
// Fetches available models from each provider API, caches for 1 hour.
// Featured models appear first; the rest are available via "show all".
// ── Claude alias → real model resolver ──────────────────────────────────────
// The Claude CLI maps short aliases (opus/sonnet/haiku) to whatever the
// current binary version points at. We probe each alias's system/init event
// (first line of stream-json, fires before any inference) to learn the real
// model id, derive an accurate display label, and persist it. When an alias
// starts resolving to a NEWER model (e.g. claude-opus-4-8 → 4-9 after a CLI
// auto-update), we Telegram-notify David: that's a model upgrade.
const { spawn: _spawnRaw } = require("child_process");
const { fetchProviderModels, clearModelsCache } = require("./src/models");
// Per-chat cost rollup: api_usd (real OpenAI/Google dollars) vs plan_usd
// (Claude Max list-equivalent, included) + downstream queue-item spend.
const { sessionCost, allSessionCosts } = require("./src/session-cost");
app.get("/api/session-costs", (_req, res) => {
  try { res.json(allSessionCosts()); } catch (e) { res.status(500).json({ error: e.message }); }
});
const { claudeBilling } = require("./src/claude-billing");
// Console-true Anthropic numbers (usage credits, plan-limit meters) — same
// figures as claude.ai Settings→Usage, via the persisted browser session.
app.get("/api/claude-billing", async (_req, res) => {
  res.json(await claudeBilling());
});
app.get("/api/session-cost", async (req, res) => {
  const sid = String(req.query.session || "").trim();
  if (!sid || sid.length < 8 || !/^[a-zA-Z0-9-]+$/.test(sid)) {
    return res.status(400).json({ error: "session query param required" });
  }
  try {
    res.json(await sessionCost(sid));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Claude-limit pace engine: rolling 5h/7d usage from the shared spend ledger,
// ceilings calibrated from observed limit hits (attention.js → recordLimitHit),
// smoothed daily target + offload signal. GET /api/pace — loopback, no auth,
// same posture as the cost endpoints above. Consumers (nh-backend enrichment,
// future routers) read it to route work to the capped GPT/Gemini lanes in the
// gaps; governor.js consults it for the "llmterminal-auto" lane.
require("./src/pace").registerRoutes(app);
app.get("/api/models", async (_req, res) => {
  try {
    const models = await fetchProviderModels();
    res.json(models);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Force-refresh: DELETE /api/models clears cache
app.delete("/api/models", (_req, res) => {
  clearModelsCache();
  res.json({ cleared: true });
});
// ---- File attribution log ----
// Sidecar append-only JSONL tracking which session wrote which file. Written
// synchronously at tool_result success time — independent of messages.db
// persistence (which can die on server kill) and the orchestratorHero previews
// DB (which depends on an HTTP roundtrip that can fail silently). This log is
// the authoritative answer to "which chat made this file?" for the drawer.
//
// Format (one per line): {"path":"/abs/path","session_id":"...","tool":"Write|Edit|Bash|...","ts":<ms>}
const { FILE_ATTRIBUTION_LOG, logFileAttribution, buildAttributionMap, _drawerWalkProjectFull, DRAWER_TIME_BUFFER_MS, DRAWER_RESULT_CAP } = require("./src/attribution");
app.get("/api/drawer-files", (req, res) => {
  const session_id = req.query.session_id || "";
  const project = req.query.project || "";
  if (!session_id && !project) return res.json({ files: [] });

  const all = loadSessions();
  let targets = [];
  if (session_id) targets = all.filter(s => s.id === session_id);
  else if (project) targets = all.filter(s => s.project === project);
  if (!targets.length) return res.json({ files: [] });

  const targetIds = new Set(targets.map(s => s.id));
  const projectsToWalk = new Set(targets.map(s => s.project).filter(Boolean));
  // Per-session linked dirs: agent can write outside its primary project
  // (e.g. a narrativeHero-content session producing assets under crankHero/),
  // session.extra_project_dirs opts those dirs in for chat-scope queries.
  // Project-scope intentionally ignores these — `?project=X` means "files
  // under X", not "files this project's sessions touched anywhere".
  const extraDirsToWalk = new Set();
  for (const s of targets) {
    if (Array.isArray(s.extra_project_dirs)) {
      for (const d of s.extra_project_dirs) {
        if (typeof d === "string" && d.startsWith("/")) extraDirsToWalk.add(d);
      }
    }
  }
  const allSessionsById = new Map(all.map(s => [s.id, s]));

  // Attribution sources (1) tool_activity rows (2) sidecar JSONL log
  const attribution = buildAttributionMap();

  // Chat-scope (session_id query) requires POSITIVE attribution — the file
  // must have a record in tool_activity or the JSONL log linking it to this
  // session. Project-scope (project query) shows every file in the project
  // dir, attributed where possible and unattributed where not.
  const isProjectScope = !!project;

  const fileMap = new Map();

  for (const proj of projectsToWalk) {
    const projDir = path.join(PROJECTS_DIR, proj);
    if (!fs.existsSync(projDir)) continue;
    const allFsFiles = _drawerWalkProjectFull(projDir);
    for (const f of allFsFiles) {
      const attr = attribution.get(f.path);
      const owner = attr ? attr.sessionId : null;
      if (isProjectScope) {
        // Project view: include all files. If attributed and attribution maps
        // to a session OUTSIDE this project, that's a stale record — show the
        // file but mark unattributed.
        const ownerIsInProject = owner && allSessionsById.get(owner)?.project === proj;
        fileMap.set(f.path, {
          path: f.path,
          ext: f.ext,
          mtime_ms: f.mtime_ms,
          size: f.size,
          title: path.basename(f.path),
          source_session_id: ownerIsInProject ? owner : null,
          source_session_title: ownerIsInProject ? (allSessionsById.get(owner)?.title || "") : "",
          attributed_by: ownerIsInProject ? attr.source : null,
        });
      } else {
        // Chat scope: strict — file must be attributed to one of the target sessions.
        if (!owner || !targetIds.has(owner)) continue;
        const sess = allSessionsById.get(owner);
        fileMap.set(f.path, {
          path: f.path,
          ext: f.ext,
          mtime_ms: f.mtime_ms,
          size: f.size,
          title: path.basename(f.path),
          source_session_id: owner,
          source_session_title: sess?.title || "",
          attributed_by: attr.source,
        });
      }
    }
  }

  // Extra linked dirs (chat scope only — see note where extraDirsToWalk is
  // built). Same attribution rule: positive match against this session.
  if (!isProjectScope) {
    for (const extraDir of extraDirsToWalk) {
      if (!fs.existsSync(extraDir)) continue;
      const allFsFiles = _drawerWalkProjectFull(extraDir);
      for (const f of allFsFiles) {
        if (fileMap.has(f.path)) continue;
        const attr = attribution.get(f.path);
        const owner = attr ? attr.sessionId : null;
        if (!owner || !targetIds.has(owner)) continue;
        const sess = allSessionsById.get(owner);
        fileMap.set(f.path, {
          path: f.path, ext: f.ext, mtime_ms: f.mtime_ms, size: f.size,
          title: path.basename(f.path),
          source_session_id: owner,
          source_session_title: sess?.title || "",
          attributed_by: attr.source,
        });
      }
    }
  }

  // Voice notes: still matched by filename timestamp to a session's window —
  // they live outside the project dir and the agent doesn't write them, the
  // /voice-note endpoint does. The JSONL log can supplement this in future
  // (the endpoint can call logFileAttribution at write time).
  try {
    const vnDir = path.join(DATA_DIR, "voice-notes");
    if (fs.existsSync(vnDir)) {
      for (const fname of fs.readdirSync(vnDir)) {
        const m = fname.match(/^vn_(\d+)_/);
        if (!m) continue;
        const vnTs = parseInt(m[1], 10);
        const full = path.join(vnDir, fname);
        // Primary: JSONL attribution if present
        let owner = attribution.get(full)?.sessionId || null;
        // Fallback: filename ts matched against any TARGET session's window
        if (!owner) {
          for (const sess of targets) {
            const ws = sess.created || 0;
            const we = sess.lastActive || Date.now();
            if (vnTs >= ws - DRAWER_TIME_BUFFER_MS && vnTs <= we + DRAWER_TIME_BUFFER_MS) {
              owner = sess.id;
              break;
            }
          }
        }
        if (!owner || !targetIds.has(owner)) continue;
        try {
          const stat = fs.statSync(full);
          const sess = allSessionsById.get(owner);
          fileMap.set(full, {
            path: full,
            ext: path.extname(fname).toLowerCase(),
            mtime_ms: vnTs,
            size: stat.size,
            title: fname,
            source_session_id: owner,
            source_session_title: sess?.title || "",
            kind: "voice",
            attributed_by: attribution.get(full) ? "jsonl" : "filename-ts",
          });
        } catch {}
      }
    }
  } catch (e) { console.error("[drawer-files] voice-note scan failed:", e.message); }

  // User-uploaded files: live in DATA_DIR/uploads/ (outside PROJECTS_DIR), so
  // they're missed by _drawerWalkProjectFull. Attribution is always written by
  // the /upload endpoint, so a strict JSONL lookup is enough — no filename-ts
  // fallback needed.
  try {
    const upDir = path.join(DATA_DIR, "uploads");
    if (fs.existsSync(upDir)) {
      for (const fname of fs.readdirSync(upDir)) {
        if (!fname.startsWith("up_")) continue; // ignore image uploads (img_*) — they're inlined into prompts, not drawer files
        const full = path.join(upDir, fname);
        const owner = attribution.get(full)?.sessionId || null;
        if (!owner || !targetIds.has(owner)) continue;
        try {
          const stat = fs.statSync(full);
          const sess = allSessionsById.get(owner);
          fileMap.set(full, {
            path: full,
            ext: path.extname(fname).toLowerCase(),
            mtime_ms: stat.mtimeMs,
            size: stat.size,
            title: fname.replace(/^up_\d+_[0-9a-f]+_/, ""),
            source_session_id: owner,
            source_session_title: sess?.title || "",
            kind: "upload",
            attributed_by: "jsonl",
          });
        } catch {}
      }
    }
  } catch (e) { console.error("[drawer-files] upload scan failed:", e.message); }

  const arr = [...fileMap.values()].sort((a, b) => b.mtime_ms - a.mtime_ms).slice(0, DRAWER_RESULT_CAP);
  res.json({ files: arr });
});

const { loadPrioritySettings, computeSessionStateServer, computePrioritySession, _persistRoiCache, _roiHaikuLookup, _roiHaikuCache, ARCHIVE_INACTIVE_DAYS } = require("./src/priority");
app.post("/api/priority-roi-rescore", express.json(), async (req, res) => {
  const ids = Array.isArray(req.body?.session_ids) ? req.body.session_ids.slice(0, 15) : [];
  if (!ids.length) return res.json({ scored: 0, skipped: 0 });
  const sessions = loadSessions();
  const sessById = new Map(sessions.map(s => [s.id, s]));
  let scored = 0, skipped = 0;
  // Fire in series (Haiku is fast; no need to hammer the runner).
  for (const sid of ids) {
    if (_roiHaikuLookup(sid)) { skipped++; continue; }
    const s = sessById.get(sid);
    if (!s) continue;
    // Build a compact transcript: last 10 messages.
    let lines = "";
    try {
      const msgs = (typeof loadMessages === "function") ? loadMessages(sid).slice(-10) : [];
      lines = msgs.map(m => {
        const r = (m.role || "").toUpperCase();
        const t = (m.text || m.summary || "").toString().slice(0, 400);
        return t ? `${r}: ${t}` : null;
      }).filter(Boolean).join("\n\n");
    } catch {}
    if (!lines || lines.length < 30) { skipped++; continue; }
    const prompt = `You are scoring how valuable it would be for David (a solo founder running multiple businesses) to act on this chat in the next hour. Return JSON ONLY:
{"score": <0-100>, "why": "<one short sentence>"}

Higher means: live deal, client waiting, money on the table, time-sensitive decision blocking other work.
Lower means: exploratory, internal cleanup, no external stakeholder, can wait.

Project: ${s.project || "?"}
Title: ${s.title || "?"}

Recent messages:
${lines}`;
    await new Promise(resolve => {
      runCheapClaude(prompt, "roi-haiku", async (parsed) => {
        const score = (typeof parsed?.score === "number") ? Math.max(0, Math.min(100, parsed.score)) : null;
        if (score !== null) {
          _roiHaikuCache.set(sid, {
            score,
            why: String(parsed.why || "").slice(0, 200),
            computed_at: Date.now(),
          });
          scored++;
        }
        resolve();
      }, s.project);
      // 8s timeout per session — runCheapClaude has its own 45s but we want to bound the request.
      setTimeout(resolve, 8000);
    });
  }
  if (scored > 0) _persistRoiCache();
  res.json({ scored, skipped, cached: _roiHaikuCache.size });
});

// Priority settings — read/write so the user can tune without redeploying.
app.get("/api/priority-settings", (_req, res) => res.json(loadPrioritySettings()));
app.post("/api/priority-settings", express.json(), (req, res) => {
  const body = req.body || {};
  const cur = loadPrioritySettings();
  const next = {
    project_roi_multipliers: { ...cur.project_roi_multipliers, ...(body.project_roi_multipliers || {}) },
    important_people: Array.isArray(body.important_people) ? body.important_people : cur.important_people,
  };
  try { fs.writeFileSync(PRIORITY_SETTINGS_FILE, JSON.stringify(next, null, 2)); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  res.json(next);
});

app.get("/api/sessions", (req, res) => {
  let s = loadSessions();
  // project="ALL" returns every project; omitted/empty also returns all;
  // any other value filters to that one project (back-compat).
  const proj = req.query.project;
  if (proj && proj !== "ALL") s = s.filter(x => x.project === proj);
  // Annotate archived status — soft (computed on the fly), based on lastActive.
  const cutoff = Date.now() - ARCHIVE_INACTIVE_DAYS * 86400 * 1000;
  const prioritySettings = loadPrioritySettings();
  s = s.map(x => {
    const p = computePrioritySession(x, prioritySettings);
    // Signal-based run state (LIVENESS plan): working / waiting_tool /
    // paused_until / awaiting_user / user_waiting / idle / wedged / dead_mid_run.
    const rs = runReg.sessionRunState(x.id, { lastMessageRole: x.lastMessageRole, lastActiveTs: x.lastActive });
    return {
      ...x,
      archived: (x.lastActive || x.created || 0) < cutoff,
      priority_score: p.score,
      priority_breakdown: p.breakdown,
      run_state: rs.state,
      wake_at: rs.wakeAt || null,
      current_tool: rs.tool || null,
    };
  });
  // Sort newest first within the result. (Frontend can re-sort by priority_score
  // for the NEEDS YOU section without losing date order elsewhere.)
  s.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  res.json(s);
});

// Full-text search across message bodies. Returns session IDs whose messages
// contain the query. Frontend ORs this with title/project matching.
app.get("/api/search", (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q || q.length < 2) return res.json({ sessionIds: [] });
  if (q.length > 200) return res.status(400).json({ error: "query too long" });
  if (!db) return res.json({ sessionIds: [] });
  try {
    // LIKE escape: backslash quotes %, _, and \ itself.
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    const rows = db
      .prepare("SELECT DISTINCT session_id FROM messages WHERE data LIKE ? ESCAPE '\\' LIMIT 500")
      .all(`%${escaped}%`);
    res.json({ sessionIds: rows.map(r => r.session_id) });
  } catch (e) {
    console.error("[search] failed:", e.message);
    res.status(500).json({ error: "search failed" });
  }
});
app.delete("/api/sessions/:id", (req, res) => {
  saveSessions(loadSessions().filter(s => s.id !== req.params.id));
  deleteMessages(req.params.id);
  res.json({ ok: true });
});


app.post("/api/sessions/bulk-archive-done", express.json(), (req, res) => {
  const olderThanDays = Number(req.body?.olderThanDays || 7);
  const cutoff = Date.now() - olderThanDays * 86400 * 1000;
  const sessions = loadSessions();
  let n = 0;
  for (const s of sessions) {
    if (s.archived) continue;
    if (!s.manualDone && s.lastMessageRole !== "email_sent") continue;
    const ts = s.manualDone || s.lastActive || 0;
    if (ts > cutoff) continue;
    s.archived = true;
    n++;
  }
  if (n > 0) saveSessions(sessions);
  res.json({ ok: true, archived: n });
});

app.post("/api/sessions/:id/state", express.json(), (req, res) => {
  const found = findSessionOr404(req.params.id, res); if (!found) return;
  const { sessions, session: s } = found;
  const body = req.body || {};
  // manualDone: tri-state — if key absent, leave alone; if truthy set; if false clear.
  if ("manualDone" in body) {
    if (body.manualDone) { s.manualDone = Date.now(); s.doneSource = "mcp"; }
    else { delete s.manualDone; delete s.doneSource; }
  }
  // starred: persistent manual ROI floor — same tri-state semantics.
  if ("starred" in body) {
    if (body.starred) s.starred = true;
    else delete s.starred;
  }
  saveSessions(sessions);
  res.json({ ok: true, manualDone: s.manualDone || null, starred: !!s.starred });
});

// Link an additional project dir to this session — opt-in cross-project view.
// Used when an agent legitimately writes outside its primary project dir
// (e.g. narrativeHero-content session producing assets under crankHero/).
// /api/drawer-files + reconcileFileAttribution honor extras for chat-scope
// queries. Validation: absolute path under /home/claude-user/projects/, not
// .credentials/, must exist on disk. Pass { path, unlink?:true } to unlink.
app.post("/api/sessions/:id/link-dir", express.json(), (req, res) => {
  const found = findSessionOr404(req.params.id, res); if (!found) return;
  const { sessions, session: s } = found;
  const body = req.body || {};
  const p = typeof body.path === "string" ? body.path.trim() : "";
  if (!p) return res.status(400).json({ error: "path is required" });
  if (!p.startsWith("/home/claude-user/projects/")) {
    return res.status(400).json({ error: "path must be under /home/claude-user/projects/" });
  }
  if (p.includes("/.credentials") || p.includes("/.env") || p.includes("/.git/")) {
    return res.status(400).json({ error: "path crosses a sensitive subtree" });
  }
  if (!fs.existsSync(p)) return res.status(400).json({ error: "path does not exist on disk" });
  if (!Array.isArray(s.extra_project_dirs)) s.extra_project_dirs = [];
  if (body.unlink) {
    s.extra_project_dirs = s.extra_project_dirs.filter(d => d !== p);
  } else if (!s.extra_project_dirs.includes(p)) {
    s.extra_project_dirs.push(p);
  }
  saveSessions(sessions);
  res.json({ ok: true, extra_project_dirs: s.extra_project_dirs });
});

// Sets lastViewed=now on a session. Frontend calls this when you open the
// session so we can tell apart "you saw the assistant's reply" from "still
// waiting on you to read it".
app.post("/api/sessions/:id/viewed", (req, res) => {
  const found = findSessionOr404(req.params.id, res); if (!found) return;
  const { sessions, session: s } = found;
  s.lastViewed = Date.now();
  saveSessions(sessions);
  res.json({ ok: true, lastViewed: s.lastViewed });
});

// Records the Gmail thread ID after a successful send so the reply poller
// can match inbound mail back to a session.
app.post("/api/sessions/:id/email-sent", express.json(), (req, res) => {
  const id = req.params.id;
  const threadId = (req.body?.threadId || "").trim();
  const account = (req.body?.account || "").trim();
  if (!threadId) return res.status(400).json({ ok: false, error: "threadId required" });
  const found = findSessionOr404(id, res); if (!found) return;
  const { sessions, session: s } = found;
  s.gmailThreadId = threadId;
  if (account) s.gmailAccount = account;
  // Initial cursor — anything that arrives AFTER this counts as a new reply.
  s.gmailLastSeenMs = Date.now();
  saveSessions(sessions);
  res.json({ ok: true });
});

// Appends an assistant message to a session. Used by the llmterminal MCP
// (llmt_complete with a summary) so the wrap-up shows up in the chat.
// Loopback only — no auth, intended for MCP tools running locally.
app.post("/api/sessions/:id/append-assistant", express.json(), (req, res) => {
  const id = req.params.id;
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "text required" });
  const found = findSessionOr404(id, res); if (!found) return;
  const { sessions, session: s } = found;
  const ts = Date.now();
  try {
    saveMessage(id, { role: "assistant", text, ts, source: "mcp_complete" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "saveMessage failed: " + e.message });
  }
  s.lastActive = ts;
  s.lastMessageRole = "assistant";
  s.lastSnippet = text.slice(0, 200);
  saveSessions(sessions);
  // Push to any connected client so the chat redraws immediately.
  try { broadcastToSession(id, { type: "history", messages: loadMessages(id) }); } catch {}
  res.json({ ok: true });
});

// Reply detected on a tracked thread — pull the session back to the top.
// Body: { fromEmail, subject, messageId, snippet, ts }
app.post("/api/sessions/:id/reactivate", express.json(), (req, res) => {
  const id = req.params.id;
  const found = findSessionOr404(id, res); if (!found) return;
  const { sessions, session: s } = found;
  const now = Date.now();
  const from = (req.body?.fromEmail || "someone").trim();
  const subject = (req.body?.subject || "").trim();
  const snippet = (req.body?.snippet || "").trim().slice(0, 200);
  // Full email body (plain text, extracted by the poller) so the chat card can
  // show the actual email — David shouldn't have to jump to Gmail to read it.
  const emailBody = String(req.body?.body || "").trim().slice(0, 20000);
  const ts = Number(req.body?.ts) || now;
  s.lastActive = ts;
  s.lastMessageRole = "email_reply";
  s.lastSnippet = `📬 Reply from ${from}` + (subject ? ` — ${subject}` : "");
  s.gmailLastSeenMs = ts;
  delete s.manualDone; // a reply un-marks any "done" state
  saveSessions(sessions);
  // Append a synthetic message so the chat view shows it.
  try {
    saveMessage(id, {
      role: "email_reply",
      ts,
      text: `📬 Reply received from ${from}` + (subject ? ` — *${subject}*` : "") + (snippet ? `\n\n> ${snippet}` : ""),
      body: emailBody || null,
      fromEmail: from, subject, messageId: req.body?.messageId || null,
    });
  } catch (e) { console.error("[reactivate] saveMessage failed:", e.message); }
  res.json({ ok: true });
});



// ---- Decision timeline / tree endpoints ----
// Append, resolve, fetch per session, fetch per project.
// Called via the llmterminal MCP server (llmt_decide, llmt_decide_resolve)
// running inside the claude spawn — loopback only, no auth.

// Decisions-framework API routes (see src/routes/decisions.js).
require("./src/routes/decisions")(app);
const TTS_CACHE_DIR = path.join(DATA_DIR, "tts-cache");
fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
const TTS_MODEL = "tts-1";
const TTS_VOICE_DEFAULT = "nova";
const TTS_MAX_CHARS = 4000;

app.post("/tts", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "missing text" });
    if (text.length > TTS_MAX_CHARS) return res.status(413).json({ error: "text too long (max " + TTS_MAX_CHARS + ")" });
    const voice = String(req.body?.voice || TTS_VOICE_DEFAULT);
    const hash = crypto.createHash("sha256").update(TTS_MODEL + "|" + voice + "|" + text).digest("hex");
    const cachePath = path.join(TTS_CACHE_DIR, hash + ".mp3");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("X-TTS-Hash", hash);
    res.setHeader("Cache-Control", "private, max-age=31536000");
    if (fs.existsSync(cachePath)) {
      res.setHeader("X-TTS-Cache", "hit");
      return fs.createReadStream(cachePath).pipe(res);
    }
    const key = process.env.OPENAI_API_KEY;
    if (!key) { console.error("[tts] OPENAI_API_KEY not set"); return res.status(503).json({ error: "OPENAI_API_KEY not set" }); }
    const t0 = Date.now();
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, voice, input: text, response_format: "mp3" })
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error("[tts] openai error", r.status, errText.slice(0, 500));
      return res.status(502).json({ error: "openai tts failed", status: r.status });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(cachePath, buf);
    console.log(`[tts] generated ${buf.length}B in ${Date.now()-t0}ms (voice=${voice}, chars=${text.length})`);
    res.setHeader("X-TTS-Cache", "miss");
    res.end(buf);
  } catch (err) {
    console.error("[tts] error:", err);
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// ---- Voice note upload + Whisper transcription ----
const VOICE_DIR = path.join(DATA_DIR, "voice-notes");

// ---- Voice-note nonces (per-WS short-lived capability tokens) ----
// Each live WebSocket gets a nonce that proves "this voice-note POST is coming
// from the WS that is currently open for this session." When the WS closes, the
// nonce dies. This prevents a phone with a stale session id in memory from
// shipping voice notes to a real-but-no-longer-active chat.
//
const { issueVoiceNonce, resolveVoiceNonce, revokeNoncesForWs } = require("./src/voice-nonce");
const { queueFile, queueAppend, queueLoad, queueSaveAll, queuePopNext, broadcastQueueState } = require("./src/queue");
fs.mkdirSync(VOICE_DIR, { recursive: true });

// Call OpenAI chat completions and return the trimmed content string (or null on failure).
const { callOpenAI, runCheapClaude, _runCheapClaudeCli, _runCheapOpenAI } = require("./src/cheap-model");
async function classifyAndCapture(transcript, title, sessionId, audioUrl) {
  const content = await callOpenAI("gpt-4o", 200, `You classify voice note transcripts. Decide if this is:
1. "reply" — a response to an ongoing conversation, a direct instruction to the current chat, a status update, OR meta-commentary about the chat itself
2. "idea" — a NEW concept, feature idea, architectural direction, bug report, or something that should be tracked as an independent task

IMPORTANT — these are ALWAYS "reply", never "idea":
- Requests to continue, complete, or clarify a previous response ("finish explaining", "complete the response", "clarify if...")
- Confirmations or follow-ups to something already discussed ("yes do that", "confirm X is included")
- References to what the AI just said or did ("the truncated response", "what you described")
- Meta-conversation about the chat session itself
- Vague fragments without a clear actionable outcome

Only classify as "idea" when the transcript describes something NEW to build, fix, change, or investigate — independent of the current conversation. When in doubt, classify as "reply".

If "idea", also extract:
- title: 5-10 word task title (must describe a concrete action, not a conversation continuation)
- description: 1-2 sentence summary of what needs to happen
- project: which project this relates to (narrativehero, crankhero, datahero, llmterminal, mediahero, oshero, or unknown)
- priority: low, normal, high, or urgent

Respond as JSON: {"type":"reply"} or {"type":"idea","title":"...","description":"...","project":"...","priority":"..."}`, transcript.slice(0, 2000));
  if (!content) return;
  let parsed;
  try { parsed = JSON.parse(content); } catch { return; }
  if (parsed.type !== "idea") return;

  // Create task in orchestrator
  console.log(`[auto-capture] new idea detected: "${parsed.title}" (project: ${parsed.project})`);
  try {
    const orchRes = await fetch(ORCH_BASE + "/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: parsed.title || title,
        description: (parsed.description || "") + "\n\n[Auto-captured from voice note" + (sessionId ? " in session " + sessionId : "") + "]\nAudio: " + audioUrl + "\n\nOriginal transcript:\n" + transcript.slice(0, 3000),
        project_id: parsed.project || "unknown",
        priority: parsed.priority || "normal",
        owner: "operator",
        origin_session: sessionId || undefined
      })
    });
    if (orchRes.ok) {
      const task = await orchRes.json();
      console.log(`[auto-capture] created task ${task.task_id || "?"}: "${parsed.title}"`);
    } else {
      console.warn("[auto-capture] orchestrator rejected:", orchRes.status);
    }
  } catch (e) {
    console.warn("[auto-capture] orchestrator unreachable:", e.message);
  }
}

app.post("/voice-note", express.raw({ type: ["audio/*", "application/octet-stream"], limit: "25mb" }), async (req, res) => {
  try {
    if (!req.body || req.body.length === 0) return res.status(400).json({ error: "no audio data" });
    // Resolve the routing target UP FRONT, before saving audio or burning Whisper
    // credits. An invalid nonce / missing session should fail fast.
    const _nonce = (req.query && req.query.nonce) || "";
    const _sidParam = (req.query && req.query.session) || "";
    let _routedSid = "";
    let _routingMode = "";
    if (_nonce) {
      const resolved = resolveVoiceNonce(_nonce);
      if (!resolved) {
        console.warn(`[voice-note] REJECTED before save — nonce=${_nonce.slice(0,8)}… expired or WS closed`);
        return res.status(401).json({ error: "voice nonce invalid — the chat session may have closed. Refresh the chat and try again.", stale_nonce: true });
      }
      _routedSid = resolved.sessionId;
      _routingMode = "nonce";
    } else if (_sidParam) {
      const allSessions = loadSessions();
      if (!allSessions.some(s => s.id === _sidParam)) {
        console.warn(`[voice-note] REJECTED before save — ghost session_id=${_sidParam.slice(0,8)}…`);
        return res.status(404).json({ error: "session_id not found — voice note not routed. Refresh the chat and try again.", ghost_session_id: _sidParam });
      }
      console.warn(`[voice-note] DEPRECATED: bare ?session=${_sidParam.slice(0,8)}… without nonce. Client is on old code.`);
      _routedSid = _sidParam;
      _routingMode = "legacy-session";
    }
    // (no routing target = drop-and-transcribe-only; allowed for compatibility)
    const ct = (req.headers["content-type"] || "").toLowerCase();
    const ext = ct.includes("webm") ? ".webm"
              : ct.includes("mp4") || ct.includes("m4a") || ct.includes("aac") || ct.includes("x-m4a") ? ".m4a"
              : ct.includes("ogg") ? ".ogg"
              : ct.includes("wav") ? ".wav" : ".m4a"; // default m4a — Safari/iOS most common
    const name = "vn_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex") + ext;
    const filePath = path.join(VOICE_DIR, name);
    fs.writeFileSync(filePath, req.body);
    console.log(`[voice-note] saved ${req.body.length}B -> ${name}`);

    // Transcribe with OpenAI Whisper
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      console.error("[voice-note] OPENAI_API_KEY not set");
      return res.json({ audioUrl: "/voice-notes/" + name, transcript: null, error: "OPENAI_API_KEY not set" });
    }
    const t0 = Date.now();
    const boundary = "----VNBoundary" + crypto.randomBytes(8).toString("hex");
    const fileContent = fs.readFileSync(filePath);
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${ext === ".m4a" ? "audio/mp4" : "audio/" + ext.slice(1)}\r\n\r\n`,
      fileContent,
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`,
      `\r\n--${boundary}--\r\n`
    ];
    const body = Buffer.concat(parts.map(p => typeof p === "string" ? Buffer.from(p) : p));
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "multipart/form-data; boundary=" + boundary,
      },
      body
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error("[voice-note] whisper error", r.status, errText.slice(0, 500));
      return res.json({ audioUrl: "/voice-notes/" + name, transcript: null, error: "transcription failed" });
    }
    const result = await r.json();
    console.log(`[voice-note] transcribed in ${Date.now()-t0}ms: "${(result.text || "").slice(0, 80)}..."`);
    // If sessionId provided, write the transcript directly to that session's persistent queue.
    // This guarantees the prompt is recorded server-side even if the client crashes / refreshes
    // before sending it.
    // Routing target was resolved up front (_routedSid: WS-bound nonce, or legacy ?session=).
    // noQueue=1: client will fire its own WS prompt with this transcript + attached
    // images, so we must NOT queue here (else two separate Claude turns fire — one for
    // the transcript-alone, one for the text+images). Still attribute the audio file.
    const _noQueue = !!(req.query && req.query.noQueue);
    if (_routedSid && result.text && !_noQueue) {
      console.log(`[voice-note] routing to session=${_routedSid.slice(0,8)}… (mode=${_routingMode})`);
      queueAppend(_routedSid, { text: result.text, source: "voice-note", audioUrl: "/voice-notes/" + name });
      // Show the pending voice-note bubble to every client on this session.
      // (If drain fires immediately, that broadcast will overwrite this with the
      // post-pop state.)
      try { broadcastQueueState(_routedSid); } catch {}
      // Try to drain immediately if the session isn't currently running anything
      try { tryDrainQueue(_routedSid); } catch (e) { console.error("[queue] drain attempt failed:", e.message); }
    }
    if (_routedSid && result.text) {
      // Robust attribution: link the saved audio file to the session in the sidecar log
      logFileAttribution(filePath, _routedSid, "voice-note");
    }
    const sid = _routedSid; // for downstream classifyAndCapture()
    // Generate a short title from the transcript
    let title = "";
    const transcript = result.text || "";
    if (transcript.length > 10) {
      try {
        const t = await callOpenAI("gpt-4o-mini", 30,
          "Generate a 3-7 word title summarizing this voice note. No quotes, no punctuation at the end. Just the title.",
          transcript.slice(0, 1000));
        if (t) { title = t; console.log(`[voice-note] title: "${title}"`); }
      } catch (e) { console.warn("[voice-note] title gen failed:", e.message); }
    }
    // Async: classify if this voice note contains a new idea/task
    // Don't block the response — fire and forget
    if (transcript.length > 30) {
      classifyAndCapture(transcript, title, sid, "/voice-notes/" + name).catch(e =>
        console.warn("[voice-note] classify failed:", e.message)
      );
    }
    res.json({ audioUrl: "/voice-notes/" + name, transcript, title });
  } catch (err) {
    console.error("[voice-note] error:", err);
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// Serve voice note audio files
app.use("/voice-notes", express.static(VOICE_DIR));

// ---- Arbitrary file upload (call recordings, PDFs, docs, anything) ----
// Mirrors the voice-note flow: nonce-gated to the current WS session, saved
// to disk, attributed to the chat, then queued as a synthetic user message
// so Claude picks it up on the next drain. Audio is auto-transcribed via
// Whisper (same key as voice-notes) when ≤25MB.
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function _isAudioMime(mt) {
  if (!mt) return false;
  return mt.startsWith("audio/") || mt === "video/mp4" || mt === "video/webm";
}
function _humanSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}
async function _transcribeAudioBuffer(buf, filenameForApi, mimeType) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { transcript: null, error: "OPENAI_API_KEY not set" };
  const boundary = "----UpBoundary" + crypto.randomBytes(8).toString("hex");
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filenameForApi}"\r\nContent-Type: ${mimeType || "audio/mp4"}\r\n\r\n`,
    buf,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`,
    `\r\n--${boundary}--\r\n`,
  ];
  const body = Buffer.concat(parts.map(p => typeof p === "string" ? Buffer.from(p) : p));
  const t0 = Date.now();
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "multipart/form-data; boundary=" + boundary },
    body,
  });
  if (!r.ok) {
    const errText = await r.text();
    console.error("[upload] whisper error", r.status, errText.slice(0, 500));
    return { transcript: null, error: "whisper HTTP " + r.status };
  }
  const result = await r.json();
  console.log(`[upload] transcribed in ${Date.now()-t0}ms: "${(result.text||"").slice(0, 80)}..."`);
  return { transcript: result.text || "", error: null };
}

app.post("/upload", express.raw({ type: "*/*", limit: "150mb" }), async (req, res) => {
  try {
    if (!req.body || req.body.length === 0) return res.status(400).json({ error: "no file data" });
    // Same nonce/session routing as /voice-note.
    const _nonce = (req.query && req.query.nonce) || "";
    const _sidParam = (req.query && req.query.session) || "";
    let _routedSid = "";
    let _routingMode = "";
    if (_nonce) {
      const resolved = resolveVoiceNonce(_nonce);
      if (!resolved) {
        console.warn(`[upload] REJECTED — nonce=${_nonce.slice(0,8)}… expired or WS closed`);
        return res.status(401).json({ error: "upload nonce invalid — the chat may have closed. Refresh and try again.", stale_nonce: true });
      }
      _routedSid = resolved.sessionId;
      _routingMode = "nonce";
    } else if (_sidParam) {
      const allSessions = loadSessions();
      if (!allSessions.some(s => s.id === _sidParam)) {
        console.warn(`[upload] REJECTED — ghost session_id=${_sidParam.slice(0,8)}…`);
        return res.status(404).json({ error: "session_id not found — upload not routed. Refresh the chat and try again.", ghost_session_id: _sidParam });
      }
      _routedSid = _sidParam;
      _routingMode = "legacy-session";
    }
    if (!_routedSid) return res.status(400).json({ error: "no active chat session for upload" });

    const origName = ((req.query && req.query.filename) || "upload.bin").toString();
    const mimeType = ((req.headers["content-type"] || "application/octet-stream").split(";")[0] || "").trim().toLowerCase();
    // Sanitize: strip path bits, restrict charset, cap length.
    const baseName = path.basename(origName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80) || "upload.bin";
    const name = "up_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex") + "_" + baseName;
    const filePath = path.join(UPLOAD_DIR, name);
    fs.writeFileSync(filePath, req.body);
    const sizeBytes = req.body.length;
    console.log(`[upload] saved ${sizeBytes}B (${mimeType}) -> ${name} for session=${_routedSid.slice(0,8)}… (mode=${_routingMode})`);
    logFileAttribution(filePath, _routedSid, "upload");

    const fileUrl = "/user-uploads/" + name;
    let transcript = null;
    let transcriptError = null;
    const isAudio = _isAudioMime(mimeType);
    if (isAudio) {
      if (sizeBytes > 25 * 1024 * 1024) {
        transcriptError = "file exceeds Whisper's 25MB direct-upload limit";
      } else {
        try {
          const t = await _transcribeAudioBuffer(req.body, baseName, mimeType);
          transcript = t.transcript; transcriptError = t.error;
        } catch (e) {
          console.error("[upload] transcription exception:", e);
          transcriptError = String(e && e.message || e);
        }
      }
    }

    // Build the synthetic user-message text. Give Claude the absolute path + a
    // clear "please process" cue; for audio, splice in the transcript.
    const sizeStr = _humanSize(sizeBytes);
    let messageText;
    if (isAudio && transcript !== null) {
      messageText = `[Uploaded audio file] ${baseName} (${mimeType}, ${sizeStr})\nPath on disk: ${filePath}\n\nWhisper transcript:\n${transcript}`;
    } else if (isAudio) {
      messageText = `[Uploaded audio file] ${baseName} (${mimeType}, ${sizeStr})\nPath on disk: ${filePath}\n\nAuto-transcription was not available (${transcriptError || "unknown reason"}). Please transcribe or otherwise process the file. For files >25MB you can chunk with ffmpeg then call Whisper per chunk.`;
    } else {
      messageText = `[Uploaded file] ${baseName} (${mimeType || "unknown type"}, ${sizeStr})\nPath on disk: ${filePath}\n\nPlease process this file appropriately — Read text/PDF/image content, extract archives, or whatever fits the task at hand.`;
    }

    queueAppend(_routedSid, {
      text: messageText,
      source: "upload",
      audioUrl: isAudio ? fileUrl : undefined,
      fileUrl,
      fileName: baseName,
      mimeType,
      sizeBytes,
    });
    try { broadcastQueueState(_routedSid); } catch {}
    try { tryDrainQueue(_routedSid); } catch (e) { console.error("[upload] drain attempt failed:", e.message); }

    res.json({ ok: true, fileUrl, name: baseName, mimeType, sizeBytes, transcript, transcriptError });
  } catch (err) {
    console.error("[upload] error:", err);
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// Serve user-uploaded files (behind CF Access + nginx David-only guard).
app.use("/user-uploads", express.static(UPLOAD_DIR));

// ---- Orchestrator task board proxy (narrativeHero :8000) ----
const ORCH_BASE = "http://localhost:8000/api/orchestrator";

// Drafts-only policy: send_gmail_email.py refuses to run without this token.
// We read it once at startup and inject into the spawn env for /api/email-draft/send only.
let LLMT_SEND_TOKEN = "";
try {
  LLMT_SEND_TOKEN = fs.readFileSync("/home/claude-user/.camohero-send/llmt-token", "utf8").trim();
} catch (e) {
  console.error("[email-draft] WARNING: cannot read send-auth token:", e.message);
}

// Shared proxy: forward a request to the orchestrator and relay the JSON response.
async function orchProxy(res, url, opts, errLabel) {
  try {
    const r = await fetch(ORCH_BASE + url, opts);
    if (!r.ok) return res.status(r.status).json({ error: errLabel || "orchestrator error", status: r.status });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "orchestrator unreachable", detail: String(err.message || err) });
  }
}

// Create a new task — proxies to narrativeHero orchestrator queue/create
app.post("/api/tasks", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!body.title) return res.status(400).json({ error: "title required" });
  orchProxy(res, "/queue/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, "orchestrator create failed");
});

app.get("/api/tasks", async (req, res) => {
  const qs = new URLSearchParams();
  if (req.query.status) qs.set("status", req.query.status);
  if (req.query.project_id) qs.set("project_id", req.query.project_id);
  qs.set("limit", req.query.limit || "100");
  orchProxy(res, "/queue/items?" + qs);
});

app.get("/api/tasks/summary", async (_req, res) => {
  orchProxy(res, "/queue/summary");
});

app.post("/api/tasks/:id/transition", express.json(), async (req, res) => {
  orchProxy(res, "/queue/items/" + req.params.id + "/transition", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
  }, "transition failed");
});

// ---- Auto-retry blocked tasks every 5 minutes ----
// Tasks with runner_exit=127 or similar transient failures get requeued automatically
async function autoRetryBlockedTasks() {
  try {
    const r = await fetch(ORCH_BASE + "/queue/items?status=blocked&limit=50");
    if (!r.ok) return;
    const data = await r.json();
    const retryable = (data.items || []).filter(t => {
      const reason = (t.blocked_reason || "").toLowerCase();
      // Auto-retry: runner failures, timeouts, transient errors
      return reason.includes("runner_exit") || reason.includes("timeout") || reason.includes("transient");
    });
    for (const t of retryable) {
      try {
        await fetch(ORCH_BASE + "/queue/items/" + t.task_id + "/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ detail: "Auto-retried by llmTerminal supervisor" })
        });
        console.log("[auto-retry] requeued:", t.task_id, t.title.slice(0, 40));
      } catch {}
    }
    if (retryable.length) console.log("[auto-retry] requeued " + retryable.length + " blocked tasks");
  } catch (e) {
    console.warn("[auto-retry] failed:", e.message);
  }
}
// Auto-verify email drafts by cross-referencing with sent log
async function autoVerifyEmails() {
  try {
    const sessions = loadSessions();
    const emailSessions = sessions.filter(s => !s.manualDone && s.lastMessageRole === "email_draft");
    if (!emailSessions.length) return;
    const sentEntries = [];
    try {
      const lines = fs.readFileSync(SENT_LOG_PATH, "utf8").trim().split("\n");
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const line of lines) {
        try { const e = JSON.parse(line); if (new Date(e.sent_at).getTime() > cutoff) sentEntries.push(e); } catch {}
      }
    } catch { return; }
    let done = 0;
    for (const s of emailSessions) {
      const match = sentEntries.find(e =>
        (e.sessionId && e.sessionId === s.id) ||
        (s.title && e.subject && s.title.toLowerCase().includes(e.subject.toLowerCase().slice(0, 30)))
      );
      if (match) { s.emailOpened = match.sent_at; s.manualDone = Date.now(); done++; }
    }
    if (done) { saveSessions(sessions); console.log("[email-verify] " + done + " email sessions auto-marked done"); }
  } catch (e) { console.warn("[email-verify]", e.message); }
}

// Run on startup after 30s, then every 5 minutes
setTimeout(() => { autoRetryBlockedTasks(); autoVerifyEmails(); }, 30000);
setInterval(() => { autoRetryBlockedTasks(); autoVerifyEmails(); }, 5 * 60 * 1000);

// ---- Per-session granted permissions (persisted to disk) ----


// ---- /api/browser-status ----
// Reports per-project browser status (running, tab count, current URL, activity level).
// Tracks URL/title/tab changes to classify activity as: navigating (just changed),
// active (changed in last minute), idle (unchanged 1-10 min), dormant (>10 min).
/* >>> llmTerminal-managed (do not edit between markers) >>> */
// BROWSER_CDP_PORTS regenerated by sync-config.py
const BROWSER_CDP_PORTS = {
  camohero: 9222,
  crankhero: 9223,
  orchestratorhero: 9224,
  llmterminal: 9225,
  langhero: 9226,
};
/* <<< llmTerminal-managed <<< */
const browserActivity = {}; // proj -> { sig, lastChange, firstSeen }
app.get('/api/browser-status', async (req, res) => {
  const proj = String(req.query.project || '').toLowerCase();
  const port = BROWSER_CDP_PORTS[proj];
  if (!port) return res.json({ running: false, tabs: 0, url: null, error: 'unknown project' });
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error('cdp ' + r.status);
    const tabs = await r.json();
    // Accept any user-visible surface: a real page if there is one, else fall back
    // to browser_ui (e.g. chrome://profile-picker/) so the VNC link still shows and
    // the user can resolve a stuck picker themselves instead of the link vanishing.
    const pages = tabs.filter(t => t.type === 'page');
    const surfaces = tabs.filter(t => t.type === 'page' || t.type === 'browser_ui');
    const top = pages[0] || surfaces[0];
    const url = top ? top.url : null;
    const title = top ? top.title : null;

    // Track changes: URL OR title OR tab count flipping counts as activity
    const sig = JSON.stringify({ url, title, n: pages.length });
    const now = Date.now();
    const prev = browserActivity[proj];
    if (!prev || prev.sig !== sig) {
      browserActivity[proj] = { sig, lastChange: now, firstSeen: (prev && prev.firstSeen) || now };
    }
    const lastChange = browserActivity[proj].lastChange;
    const idleMs = now - lastChange;
    let activity;
    if (idleMs < 10000) activity = 'navigating';
    else if (idleMs < 60000) activity = 'active';
    else if (idleMs < 600000) activity = 'idle';
    else activity = 'dormant';

    res.json({
      running: true,
      tabs: pages.length,
      url, title,
      activity,
      idleSec: Math.round(idleMs / 1000),
    });
  } catch (e) {
    res.json({ running: false, tabs: 0, url: null, error: e.message });
  }
});


// ---- noVNC browser viewer served at /vnc/ ----
// Serves noVNC static files and proxies the WebSocket to the llmterminal websockify (port 6083).
const NOVNC_WS_PORT = 6083;
app.use('/vnc', express.static('/usr/share/novnc'));
// WebSocket proxy: forward /vnc/websockify upgrades to websockify at port 6083
const net = require("net");
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') return; // let the main WSS handle /ws
  if (req.url.startsWith('/vnc/websockify') || req.url.startsWith('/websockify')) {
    const target = net.createConnection(NOVNC_WS_PORT, '127.0.0.1', () => {
      // Forward the raw HTTP upgrade request to websockify
      target.write(
        req.method + ' /websockify HTTP/' + req.httpVersion + '\r\n' +
        Object.entries(req.headers).map(([k,v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n'
      );
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  }
});

// ---- /api/email-draft/send ----
// camoHero-only. Shells out to camoHero/scripts/send_gmail_email.py (no --dry-run)
// after validating the session belongs to the camoHero project. Honors the same
// pre-send checks (sign-off / URL trust / dedup) as a CLI invocation.

// In-browser Claude OAuth re-auth routes (see src/auth.js).
require("./src/auth")(app);

// Map session.project -> default sending account (matches connection.js helper).
// All sends still shell out to camoHero/scripts/send_gmail_email.py with all
// safety checks; project just picks the From: identity.
function _defaultFromAccountForProject(project) {
  const p = String(project || "").toLowerCase();
  if (p === "camohero") return "camofiles";
  return "crankwheel";
}

app.post("/api/email-draft/send", express.json(), (req, res) => {
  const { sessionId, to, cc, subject, body, fromAccount, threadId, attachments, force, draftTs } = req.body || {};
  if (!sessionId || !to || !subject || !body) {
    return res.status(400).json({ ok: false, error: "missing fields (sessionId, to, subject, body required)" });
  }
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ ok: false, error: "session not found" });
  const projectDefault = _defaultFromAccountForProject(session.project);
  const account = (fromAccount && /^[a-z0-9_-]+$/.test(fromAccount)) ? fromAccount : projectDefault;
  const args = [
    "/home/claude-user/projects/camoHero/scripts/send_gmail_email.py",
    "--from", account,
    "--to", to,
    "--subject", subject,
    "--body", body,
  ];
  if (cc) { args.push("--cc", cc); }
  if (threadId && /^[A-Za-z0-9_-]+$/.test(threadId)) { args.push("--thread-id", threadId); }
  // Attachments: identity-aware allowlist. crankwheel-account sends can attach
  // from crankHero/; camofiles-account sends from camoHero/. The session's own
  // project dir also always qualifies. Fixes the "PDF at crankHero/... from an
  // orchestratorHero chat sent as david@crankwheel.com" case that previously
  // 400'd and forced the assistant to fall back to "please attach it yourself".
  if (Array.isArray(attachments) && attachments.length) {
    const identityProject = account === "camofiles" ? "camoHero" : "crankHero";
    const allowedPrefixes = Array.from(new Set([
      "/home/claude-user/projects/camoHero/",
      "/home/claude-user/projects/" + identityProject + "/",
      "/home/claude-user/projects/" + session.project + "/",
    ]));
    for (const ap of attachments) {
      if (typeof ap !== "string") {
        return res.status(400).json({ ok: false, error: "attachment must be a string path" });
      }
      const abs = path.resolve(ap);
      if (!allowedPrefixes.some(p => abs.startsWith(p))) {
        return res.status(400).json({
          ok: false,
          error: `attachment outside allowed dirs (camoHero/, ${identityProject}/, or ${session.project}/): ${ap}`,
        });
      }
      if (!fs.existsSync(abs)) {
        return res.status(400).json({ ok: false, error: `attachment not found: ${ap}` });
      }
      args.push("--attach", abs);
    }
  }
  if (force === true) { args.push("--force"); }
  const proc = spawn("/usr/bin/python3", args, {
    cwd: "/home/claude-user/projects/camoHero",
    uid: 1000, gid: 1000,
    env: { HOME: "/home/claude-user", PATH: process.env.PATH, LANG: "en_US.UTF-8", LLMT_SEND_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "", stderr = "";
  proc.stdout.on("data", c => { stdout += c.toString(); });
  proc.stderr.on("data", c => { stderr += c.toString(); });
  proc.on("close", (code) => {
    if (code === 0) {
      const m = stdout.match(/Message ID: (\S+)/);
      const tm = stdout.match(/Thread ID:\s*([A-Za-z0-9_-]+)/);
      const sentAt = Date.now();
      saveMessage(sessionId, { role: "email_sent", to, cc: cc || "", subject, account, message_id: m ? m[1] : null, ts: sentAt });
      // Patch the original draft row with the values that were actually sent
      // (the user may have edited the agent's draft in place) plus a `sent`
      // flag. Without this, a tab-switch + reconnect re-renders the card from
      // the original draft text and the user can't tell what actually went out.
      if (draftTs) {
        try {
          updateMessageByTs(sessionId, draftTs, "email_draft", {
            to, cc: cc || "", subject, body,
            sent: true,
            sent_ts: sentAt,
            message_id: m ? m[1] : null,
            account,
            forced: force === true ? true : undefined,
          });
        } catch (e) { console.error("[email-draft/send] draft row patch failed:", e.message); }
      }
      // Track the Gmail thread on the session so the reply poller can match replies.
      try {
        const sessions = loadSessions();
        const ss = sessions.find(x => x.id === sessionId);
        if (ss) {
          if (tm) ss.gmailThreadId = tm[1];
          ss.gmailAccount = account;
          ss.gmailLastSeenMs = Date.now();
          saveSessions(sessions);
        }
      } catch (e) { console.error("[email-draft/send] thread track failed:", e.message); }
      res.json({ ok: true, message_id: m ? m[1] : null, thread_id: tm ? tm[1] : null, account, output: stdout.slice(-2000) });
    } else {
      // Surface the most useful line of the failure (BLOCKED [...] line) to the UI
      const blocked = stdout.match(/BLOCKED[^\n]+|WARNING[^\n]+/);
      res.status(400).json({
        ok: false, code,
        error: blocked ? blocked[0] : (stderr.split("\n").pop() || "send failed"),
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
      });
    }
  });
  proc.on("error", (e) => {
    res.status(500).json({ ok: false, error: "spawn failed: " + e.message });
  });
});

// ---- /api/deferred-restart ----
// The SAFE way for an agent to restart a service it is running inside. A direct
// helper-socket restart mid-turn deadlocks: gracefulShutdown waits for active
// subprocesses, the only active subprocess is the agent that asked, and 60s
// later systemd SIGKILLs it before its reply reaches David (happened twice on
// 2026-07-29 — the chat just went blank). This queues the restart and returns
// immediately; deferredRestart.tick() fires it once no run is in flight.
app.post("/api/deferred-restart", express.json(), (req, res) => {
  const { unit, reason, sessionId } = req.body || {};
  if (!unit) return res.status(400).json({ ok: false, error: "unit required" });
  const out = deferredRestart.request({ unit, reason, sessionId });
  return res.status(out.ok ? 200 : 400).json(out);
});
app.get("/api/deferred-restart", (req, res) => res.json(deferredRestart.status()));

// ---- /api/outbox-capture ----
// The NO-LOSS net (2026-07-07, after David's queued messages vanished): the
// client posts every unacked outbox message here over plain HTTP (works when
// the WS is dead/zombie). The message becomes durable in the session's
// persistent queue file immediately and fires via the normal drain machinery.
// Exactly-once: skipped if the client_id was already delivered (saved message)
// or is already queued (queueAppend dedupes). The client drops the item from
// its outbox only after this returns ok:true.
app.post("/api/outbox-capture", express.json(), (req, res) => {
  const { sessionId, client_id, text, source } = req.body || {};
  if (!sessionId || !client_id || !text) {
    return res.status(400).json({ ok: false, error: "sessionId, client_id, text required" });
  }
  const sessions = loadSessions();
  if (!sessions.find(s => s.id === sessionId)) {
    return res.status(404).json({ ok: false, error: "session not found" });
  }
  // Already delivered via WS? (saved as a user message)
  try {
    const existing = loadMessages(sessionId);
    if (existing.some(m => m.role === "user" && m.client_id === client_id)) {
      return res.json({ ok: true, dup: "delivered" });
    }
  } catch {}
  const appended = queueAppend(sessionId, {
    text: String(text), source: source || "outbox-capture", client_id, ts: Date.now(),
  });
  if (!appended) return res.status(500).json({ ok: false, error: "queue append failed" });
  console.log("[outbox-capture] secured message for", sessionId, ":", String(text).slice(0, 60));
  try { broadcastQueueState(sessionId); } catch {}
  // Fire it if the session is idle (drain no-ops when a run is active).
  setTimeout(() => { try { tryDrainQueue(sessionId); } catch (e) { console.error("[outbox-capture] drain failed:", e.message); } }, 100);
  return res.json({ ok: true });
});

// ---- /api/email-draft/test-send ----
// Session-less sibling of /api/email-draft/send for the campaigns dashboard's
// "Send test to my inbox" button. The safety boundary is NOT a session but a
// hardcoded recipient allowlist: it can ONLY deliver to David's own addresses,
// so nh-backend can render a campaign email exactly (merge sentinel, signature
// and all) and see it in a real inbox. --force skips content checks because the
// recipient is provably the operator himself. Still the ONLY sender is camoHero's
// token-gated script; nh-backend never touches Gmail or the token.
const TEST_SEND_RECIPIENTS = new Set(["david@crankwheel.com", "david@camofiles.app"]);
app.post("/api/email-draft/test-send", express.json(), (req, res) => {
  const { to, subject, body, fromAccount, html } = req.body || {};
  if (!to || !subject || !body) {
    return res.status(400).json({ ok: false, error: "missing fields (to, subject, body required)" });
  }
  if (!TEST_SEND_RECIPIENTS.has(String(to).toLowerCase().trim())) {
    return res.status(403).json({ ok: false, error: "test-send only delivers to the operator's own addresses" });
  }
  const account = (fromAccount && /^[a-z0-9_-]+$/.test(fromAccount)) ? fromAccount : "crankwheel";
  const args = [
    "/home/claude-user/projects/camoHero/scripts/send_gmail_email.py",
    "--from", account, "--to", to, "--subject", subject, "--body", body,
    "--force",
  ];
  if (html === true) { args.push("--html"); }
  const proc = spawn("/usr/bin/python3", args, {
    cwd: "/home/claude-user/projects/camoHero",
    uid: 1000, gid: 1000,
    env: { HOME: "/home/claude-user", PATH: process.env.PATH, LANG: "en_US.UTF-8", LLMT_SEND_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "", stderr = "";
  proc.stdout.on("data", c => { stdout += c.toString(); });
  proc.stderr.on("data", c => { stderr += c.toString(); });
  proc.on("close", (code) => {
    if (code === 0) {
      const m = stdout.match(/Message ID: (\S+)/);
      res.json({ ok: true, message_id: m ? m[1] : null, account, to });
    } else {
      const blocked = stdout.match(/BLOCKED[^\n]+|WARNING[^\n]+/);
      res.status(400).json({ ok: false, code, error: blocked ? blocked[0] : (stderr.split("\n").pop() || "send failed"), stdout: stdout.slice(-1500) });
    }
  });
  proc.on("error", (e) => { res.status(500).json({ ok: false, error: "spawn failed: " + e.message }); });
});



// ---- /api/file ----
// Serves camoHero project files and upload attachments for preview/iframe rendering.
// Path must be under an explicit allowlist — never traverses outside.
const FILE_SERVE_ALLOWLIST = [
  '/home/claude-user/projects/',           // any project dir (camoHero, crankHero, llmTerminal, etc.)
  '/home/claude-user/.llm-terminal/uploads/',
  '/home/claude-user/.llm-terminal/voice-notes/',  // serve voice notes for inline audio playback
];
const FILE_SERVE_MIME = {
  '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.csv': 'text/csv', '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.webm': 'audio/webm',
};
app.get('/api/file', (req, res) => {
  const raw = String(req.query.path || '');
  if (!raw) return res.status(400).json({ error: 'path required' });
  const abs = path.resolve(raw);
  if (!FILE_SERVE_ALLOWLIST.some(p => abs.startsWith(p))) return res.status(403).json({ error: 'path not allowed' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });
  const ext = path.extname(abs).toLowerCase();
  const mime = FILE_SERVE_MIME[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // No headers meant heuristic browser caching — edited pinned files rendered
  // stale (2026-07-05 "the plan document did not update"). Text/docs must
  // revalidate every open; audio/video renders are immutable, keep them
  // cacheable for mobile replay.
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    res.setHeader('Cache-Control', 'private, max-age=86400');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  fs.createReadStream(abs).pipe(res);
});

// ---- Open-in-Gmail intent log ----
// Written when the user taps an external-compose button on the action card,
// in the same JSONL camoHero/data/sent_log.py reads for cross-channel dedup.
// The hash functions mirror camoHero/data/sent_log.py exactly — keep in sync.
const _crypto = require("crypto");
const SENT_LOG_PATH = "/home/claude-user/projects/dataHero/.credentials/gmail_sent_log.jsonl";

function _sentLogKey(to, subject) {
  const raw = `${(to || "").toLowerCase().trim()}|${(subject || "").toLowerCase().trim()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}
function _bodyHash(body) {
  let clean = (body || "").toLowerCase().trim();
  for (const marker of ["best,", "cheers,", "camofileshero", "-- \n"]) {
    const idx = clean.lastIndexOf(marker);
    if (idx > 0) clean = clean.slice(0, idx);
  }
  return crypto.createHash("sha256").update(clean).digest("hex").slice(0, 24);
}

app.post("/api/email-draft/log-intent", express.json(), (req, res) => {
  const { sessionId, to, cc, subject, body, channel } = req.body || {};
  if (!to || !subject) {
    return res.status(400).json({ ok: false, error: "to + subject required" });
  }
  const session = (loadSessions() || []).find(s => s.id === sessionId);
  const project = session?.project || "";
  const entry = {
    key: _sentLogKey(to, subject),
    body_hash: _bodyHash(body || ""),
    to,
    cc: cc || "",
    subject,
    message_id: null,
    thread_id: null,
    sent_at: new Date().toISOString(),
    sent_by: "open_in_gmail_intent",
    channel: channel || "open_in_gmail",
    project,
    sessionId: sessionId || "",
    from_account: "(manual via " + (channel || "Gmail UI") + ")",
    from_email: "",
  };
  try {
    fs.appendFileSync(SENT_LOG_PATH, JSON.stringify(entry) + "\n");
    // Auto-mark session as done — user opened email externally
    if (sessionId) {
      const sessions = loadSessions();
      const s = sessions.find(x => x.id === sessionId);
      if (s) {
        s.emailOpened = Date.now();
        s.manualDone = Date.now();
        saveSessions(sessions);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


const { sessionPermissions, loadPermissions, savePermissions, ensurePermissionsLoaded } = require("./src/permissions");
// ---- Auto-preview file writes ----
// When the agent uses Write/Edit/MultiEdit, post a preview to narrativeHero
// so the file shows up in the Files drawer without the agent having to do it.
// Track file_path -> preview_id per session so we update instead of duplicating
const { summarizeToolUse, autoCreatePreview, autoDetectBashFiles } = require("./src/tools");
const { spawnDecisionExtractor, spawnContractCheck, reconcileFileAttribution } = require("./src/supervisors");
const { runClaude, fireQueueHeadless, tryDrainQueue, killExistingClaudeFor } = require("./src/providers/claude");
require("./src/ws/connection").registerWsHandlers();
const PORT = process.env.PORT || 7683;
// Jobs ledger — glass-box visibility + the orchestrator worker substrate (§4).
const jobsLedger = require("./src/jobs");
app.get("/api/jobs", (_req, res) => res.json(jobsLedger.listJobs()));
setInterval(() => { try { jobsLedger.sweepStalled(); } catch {} }, 30000).unref();

server.listen(PORT, "127.0.0.1", () => console.log("llmTerminal on port", PORT, "(127.0.0.1 only; reached via nginx/tunnel)"));
try { require("./src/leak-trace").start(); } catch (e) { console.log("[leak-trace] failed to start:", e.message); }

// ---- Deferred restart drain-watcher ----
// Cheap poll rather than a hook on every run-completion path: runs end in
// several places (result event, proc close, kill, stall sweep) and a restart
// that fires 3s late is fine, whereas one missed completion path would strand
// the request forever.
setInterval(() => {
  try { deferredRestart.tick(activeProcs.size); }
  catch (e) { console.error("[deferred-restart] tick failed:", e.message); }
}, 3000).unref();

// ---- Graceful shutdown ----
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, waiting for active work (max 60s)`);
  // Snapshot the sessions with live runs NOW (crash-safe even if we never reach
  // the post-drain rewrite); startup recovery consumes this file (WS1b).
  shutdownSnap.writeSnapshot(activeProcBySession.keys(), signal);
  try { wss.close(); } catch {}
  try { server.close(); } catch {}
  const start = Date.now();
  while (Date.now() - start < 60000) {
    if (activeProcs.size === 0) break;
    console.log(`[shutdown] ${activeProcs.size} active subprocess(es)...`);
    await new Promise(r => setTimeout(r, 1000));
  }
  if (activeProcs.size > 0) {
    console.log(`[shutdown] forcing exit with ${activeProcs.size} stuck subprocess(es)`);
  }
  // Rewrite with the survivors: runs that drained during the grace window
  // answered their prompt and drop out; what's left is exactly what systemd
  // is about to SIGKILL.
  shutdownSnap.writeSnapshot(activeProcBySession.keys(), signal + " post-drain");
  try { if (db) db.close(); } catch {}
  console.log("[shutdown] exiting");
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

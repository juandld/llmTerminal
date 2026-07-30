// run-registry.js — provable per-session run state (LIVENESS-AND-FRUITION-PLAN Phase 0-2).
//
// One entry per session, fed from a single tap inside runClaude's stdout loop:
// every stream byte, every tool_use/tool_result, ScheduleWakeup args, the result
// event, and proc close. The sweeper and the wake scheduler read verdicts from
// here instead of guessing from message age — a backgrounded phone, a 20-minute
// thinking stretch, or a long subagent no longer look like death.
//
// Persisted (debounced) to ~/.llm-terminal/run-registry.json so scheduled wakes
// and orphan pids survive a server restart. Registry state is advisory for
// display but LOAD-BEARING for two things only: (1) the sweeper's wedged/dead
// verdicts, (2) re-firing ScheduleWakeup loops. Everything else stays on the
// canonical message/session records.
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");
const { activeProcBySession } = require("./proc-state");

const REGISTRY_PATH = path.join(DATA_DIR, "run-registry.json");
// Durable wakeups (loop-hardening WS1a, 2026-07-04): the wake authority on disk.
// Written synchronously by the SAME armWake/disarmWake pair that mutates the
// in-memory wake fields, so persistence cannot drift from behavior. The
// debounced run-registry.json snapshot is display/verdict state; this file is
// what boot trusts to re-arm loops.
const PENDING_WAKEUPS_PATH = path.join(DATA_DIR, "pending-wakeups.json");

const STREAM_FRESH_MS = 180 * 1000;      // stdout bytes this recent = provably working
const DEAD_GRACE_MS = 60 * 1000;         // proc-gone-mid-tool grace before marking (onClose usually beats us)
const LEGACY_STALL_MS = 15 * 60 * 1000;  // fallback for sessions with no registry entry (pre-deploy runs, openai/google)
const WEDGE_FLAT_SAMPLES = 2;            // consecutive sweep samples with zero cpu+io delta => wedged

// Per-tool in-flight budgets. Mirrors the env caps handed to the CLI at spawn
// (providers/claude.js childEnv) — a tool still "open" past its cap means the
// CLI's own timeout failed to fire, so we stop vouching for it and fall through
// to the cpu/io check.
const TOOL_BUDGET_DEFAULT_MS = 3 * 60 * 1000;
const TOOL_BUDGETS = [
  { re: /^Bash$/, ms: parseInt(process.env.BASH_MAX_TIMEOUT_MS || "600000", 10) + 60000 },
  { re: /^(Agent|Task|Workflow|Monitor|Skill)$/, ms: 30 * 60 * 1000 }, // subagents legitimately run long
  { re: /^mcp__/, ms: parseInt(process.env.MCP_TOOL_TIMEOUT || "120000", 10) + 30000 },
];
function toolBudgetMs(name) {
  for (const b of TOOL_BUDGETS) if (b.re.test(name || "")) return b.ms;
  return TOOL_BUDGET_DEFAULT_MS;
}

const reg = new Map(); // sessionId -> entry

let _saveTimer = null;
function _persist() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { fs.writeFileSync(REGISTRY_PATH, JSON.stringify([...reg.values()])); }
    catch (e) { console.error("[run-registry] persist failed:", e.message); }
  }, 1000);
  _saveTimer.unref?.();
}

// ---- durable wakeups: one arm path, one disarm path ----
// Keyed by session_id (one pending wake per session — matches the registry's
// one-entry-per-session model and ScheduleWakeup's re-arm-each-turn contract).
function _readPendingWakeups() {
  try { return JSON.parse(fs.readFileSync(PENDING_WAKEUPS_PATH, "utf8")) || {}; }
  catch { return {}; }
}
function _writePendingWakeups(pend) {
  // write-then-rename so a crash mid-write can't leave a torn file
  try {
    const tmp = PENDING_WAKEUPS_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(pend, null, 2));
    fs.renameSync(tmp, PENDING_WAKEUPS_PATH);
  } catch (e) { console.error("[wakeup] pending-wakeups persist failed:", e.message); }
}

// The ONLY place a wake becomes live: sets the in-memory fields AND persists
// the pending-wakeups entry in one motion. `why` is the greppable lifecycle
// verb ("armed", "armed (boot re-arm)", ...).
function armWake(sessionId, wake, why = "armed") {
  if (!sessionId || !wake || typeof wake.fireAt !== "number") return null;
  let e = reg.get(sessionId);
  if (!e) {
    // Boot re-arm for a session whose registry row was buried/lost — stub an
    // ended entry so dueWakes()/paused_until still see the wake.
    e = {
      sessionId, pid: null, provider: "claude",
      spawnedAt: Date.now(), lastStreamAt: 0,
      openTools: {}, wakeAt: null, wakeReason: null, wakePrompt: null, wakeToolId: null,
      resultSeen: false, endedAt: Date.now(), exitCode: null,
      procStat: null, flatSamples: 0, adopted: false,
    };
    reg.set(sessionId, e);
  }
  e.wakeAt = wake.fireAt;
  e.wakeReason = String(wake.reason || "").slice(0, 200);
  e.wakePrompt = typeof wake.prompt === "string" ? wake.prompt : null;
  e.wakeToolId = wake.toolId || null;
  e.wakeLate = !!wake.late;
  const pend = _readPendingWakeups();
  pend[sessionId] = {
    session_id: sessionId,
    fire_at: e.wakeAt,
    prompt: e.wakePrompt,
    reason: e.wakeReason,
    armed_at: wake.armedAt || Date.now(),
    late: e.wakeLate,
  };
  _writePendingWakeups(pend);
  console.log("[wakeup]", why, sessionId.slice(0, 8),
    "fire_at=" + new Date(e.wakeAt).toISOString(),
    "reason:", e.wakeReason.slice(0, 60));
  _persist();
  return e;
}

// The ONLY place a wake dies. `cause` is the greppable lifecycle verb:
// "fired" / "late-fired" / "superseded (...)" / "lost (...)" / "cancelled (...)".
function disarmWake(sessionId, cause = "cleared") {
  if (!sessionId) return false;
  const e = reg.get(sessionId);
  const hadLive = !!(e && e.wakeAt);
  if (e) { e.wakeAt = e.wakeReason = e.wakePrompt = e.wakeToolId = null; e.wakeLate = false; }
  const pend = _readPendingWakeups();
  const hadPending = Object.prototype.hasOwnProperty.call(pend, sessionId);
  if (hadPending) { delete pend[sessionId]; _writePendingWakeups(pend); }
  if (hadLive || hadPending) console.log("[wakeup]", cause, sessionId.slice(0, 8));
  if (e) _persist();
  return hadLive || hadPending;
}

function _pidCmdline(pid) {
  try { return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8"); } catch { return null; }
}
// Alive AND still the process we spawned (guards pid reuse for adopted orphans).
function _pidAlive(e) {
  if (!e || !e.pid) return false;
  const cmd = _pidCmdline(e.pid);
  if (cmd == null) return false;
  return /claude/i.test(cmd) || /node/i.test(cmd); // CLI runs as node; bwrap keeps argv0
}
// One cpu+io sample. cpu = utime+stime ticks, io = rchar+wchar bytes. A proc
// waiting on a streaming API response keeps rchar growing even when stdout is
// silent (long thinking blocks) — that's the signal age-based sweeping missed.
function _procSample(pid) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    // fields after the comm "(...)" — split on the closing paren to survive spaces in comm
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cpu = parseInt(rest[11], 10) + parseInt(rest[12], 10); // utime, stime
    let io = 0;
    try {
      const iotxt = fs.readFileSync("/proc/" + pid + "/io", "utf8");
      const r = /rchar:\s*(\d+)/.exec(iotxt), w = /wchar:\s*(\d+)/.exec(iotxt);
      io = (r ? parseInt(r[1], 10) : 0) + (w ? parseInt(w[1], 10) : 0);
    } catch {} // /proc/<pid>/io can be unreadable cross-uid; cpu alone still works
    return { cpu, io, at: Date.now() };
  } catch { return null; }
}

// ---- lifecycle hooks (called from providers/claude.js) ----

function runStarted(sessionId, pid, provider) {
  if (!sessionId) return;
  // A new turn supersedes any prior wake: the model re-arms each iteration by
  // calling ScheduleWakeup again (its contract), so a wake that isn't re-set
  // this turn is dead — David intervened or the loop chose to end. Wake-fired
  // turns are unaffected: the sweep disarms ("fired") before spawning.
  const prev = reg.get(sessionId);
  if (prev && prev.wakeAt) disarmWake(sessionId, "superseded (new turn started before it fired)");
  const e = {
    sessionId, pid: pid || null, provider: provider || "claude",
    spawnedAt: Date.now(), lastStreamAt: Date.now(),
    openTools: {},            // tool_use id -> {name, startedAt}
    wakeAt: null, wakeReason: null, wakePrompt: null, wakeToolId: null,
    resultSeen: false, endedAt: null, exitCode: null,
    procStat: null, flatSamples: 0, adopted: false,
  };
  reg.set(sessionId, e);
  _persist();
  return e;
}

function streamActivity(sessionId) {
  const e = reg.get(sessionId);
  if (!e) return;
  e.lastStreamAt = Date.now();
  // no persist here — lastStreamAt is display/verdict state; the debounced
  // persists from tap()/runEnded keep the on-disk copy close enough.
}

// Parse one stream-json message for lifecycle signals.
function tap(sessionId, msg) {
  const e = reg.get(sessionId);
  if (!e || !msg || typeof msg !== "object") return;
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b?.type !== "tool_use") continue;
      e.openTools[b.id || "?"] = { name: b.name || "tool", startedAt: Date.now() };
      if (b.name === "ScheduleWakeup" && b.input && typeof b.input.delaySeconds === "number") {
        const clamped = Math.min(3600, Math.max(60, b.input.delaySeconds)); // runtime clamp
        armWake(sessionId, {
          fireAt: Date.now() + clamped * 1000,
          reason: b.input.reason,
          prompt: b.input.prompt,
          toolId: b.id || null,
        }, "armed (in " + clamped + "s)");
      }
      _persist();
    }
  }
  if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b?.type !== "tool_result" || !b.tool_use_id) continue;
      delete e.openTools[b.tool_use_id];
      // A denied/errored ScheduleWakeup must not leave a live wake behind.
      if (b.is_error && e.wakeToolId === b.tool_use_id) {
        disarmWake(sessionId, "cancelled (ScheduleWakeup tool_result error)");
      }
      _persist();
    }
  }
  if (msg.type === "result") { e.resultSeen = true; e.openTools = {}; _persist(); }
}

function runEnded(sessionId, code) {
  const e = reg.get(sessionId);
  if (!e) return;
  e.endedAt = Date.now();
  e.exitCode = code;
  e.openTools = {};
  _persist();
}

function getEntry(sessionId) { return reg.get(sessionId) || null; }
// Kept as the external API; `cause` is the greppable lifecycle verb
// ("fired", "late-fired", "lost (...)"). Routes through the single disarm path.
function clearWake(sessionId, cause = "cleared") { disarmWake(sessionId, cause); }
// Sessions whose wake is due. Caller filters live procs / throttle.
function dueWakes(now = Date.now()) {
  return [...reg.values()].filter(e => e.wakeAt && e.wakeAt <= now);
}

// ---- the verdict ----
// PURE read: no sampling mutation, safe to call from /api/sessions and
// priority ranking at any frequency. Wedge evidence (flatSamples) is only
// advanced by sampleForWedge(), which the 5-min sweeper calls — so a wedged
// verdict always rests on samples a full sweep apart.
function sessionRunState(sessionId, opts = {}) {
  const now = Date.now();
  const e = reg.get(sessionId);
  const hasLiveProc = activeProcBySession.has(sessionId);
  const running = e && !e.endedAt && (hasLiveProc || _pidAlive(e));

  if (running) {
    if (e.resultSeen) return { state: "idle", detail: "draining" }; // model done, MCP shutdown lag
    if (now - e.lastStreamAt < STREAM_FRESH_MS) return { state: "working", detail: "streaming" };
    const open = Object.values(e.openTools);
    const within = open.find(t => now - t.startedAt < toolBudgetMs(t.name));
    if (within) return { state: "waiting_tool", tool: within.name, tool_elapsed_ms: now - within.startedAt, tool_budget_ms: toolBudgetMs(within.name) };
    if ((e.flatSamples || 0) >= WEDGE_FLAT_SAMPLES) return { state: "wedged", pid: e.pid, flat_samples: e.flatSamples };
    return { state: "working", detail: open.length ? "tool over budget, cpu/io watch" : "quiet, cpu/io watch" };
  }

  if (e && e.wakeAt && e.wakeAt > now) return { state: "paused_until", wakeAt: e.wakeAt, reason: e.wakeReason };

  const role = opts.lastMessageRole || "";
  if (role === "question" || role === "permission_denied") return { state: "awaiting_user" };
  if (["tool_activity", "tool_result", "permission_granted"].includes(role)) {
    if (e) {
      if (e.wakeAt && e.wakeAt <= now) return { state: "paused_until", wakeAt: e.wakeAt, overdue: true }; // wake sweep owns it
      const diedAt = Math.max(e.endedAt || 0, e.lastStreamAt || 0) || e.spawnedAt;
      if (now - diedAt < DEAD_GRACE_MS) return { state: "working", detail: "grace" };
      return { state: "dead_mid_run", pid: e.pid, exitCode: e.exitCode };
    }
    // No registry entry: pre-registry run or openai/google (no subprocess to
    // interrogate). Conservative age fallback — the ONE place age survives.
    const lastTs = opts.lastActiveTs || 0;
    return now - lastTs > LEGACY_STALL_MS
      ? { state: "dead_mid_run", legacy: true }
      : { state: "working", detail: "legacy-age" };
  }
  if (role === "user") return { state: "user_waiting" };
  return { state: "idle" };
}

// Advance wedge evidence for a live-but-silent proc. Sweeper-only.
function sampleForWedge(sessionId) {
  const e = reg.get(sessionId);
  if (!e || e.endedAt || !_pidAlive(e)) return;
  const s = _procSample(e.pid);
  if (!s) return;
  if (e.procStat && s.cpu === e.procStat.cpu && s.io === e.procStat.io) e.flatSamples = (e.flatSamples || 0) + 1;
  else e.flatSamples = 0;
  e.procStat = s;
  _persist();
}

// ---- boot ----
// Reload persisted entries; adopt orphan pids that are still our claude procs
// (we can't re-attach to their stdout, so their verdicts run on cpu/io only),
// bury the rest so dead_mid_run grace runs from boot, not from stale timestamps.
function loadRegistry() {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")); } catch {}
  const now = Date.now();
  let adopted = 0, buried = 0;
  for (const e of rows) {
    if (!e || !e.sessionId) continue;
    e.openTools = e.openTools || {};
    if (!e.endedAt && _pidAlive(e)) {
      e.adopted = true;
      e.lastStreamAt = 0; // can't see its stdout anymore — force cpu/io path
      adopted++;
    } else if (!e.endedAt) {
      e.endedAt = now; e.exitCode = null; buried++;
    }
    reg.set(e.sessionId, e);
  }
  if (rows.length) console.log("[run-registry] loaded", rows.length, "entries (adopted", adopted, "orphans, buried", buried + ")");

  // ---- durable wakeups: re-arm from pending-wakeups.json (the authority) ----
  // Future wakes re-arm as-is; past-due ones re-arm flagged late:true so the
  // wake sweep fires them on its first pass with a late marker in the prompt.
  const pend = _readPendingWakeups();
  for (const [sid, w] of Object.entries(pend)) {
    if (!w || typeof w.fire_at !== "number") {
      console.log("[wakeup] lost (malformed pending entry dropped at boot)", String(sid).slice(0, 8));
      delete pend[sid];
      _writePendingWakeups(pend);
      continue;
    }
    const late = w.fire_at <= now;
    armWake(sid, {
      fireAt: w.fire_at, reason: w.reason, prompt: w.prompt,
      toolId: null, late, armedAt: w.armed_at,
    }, late ? "armed (boot re-arm, past due — will late-fire)" : "armed (boot re-arm)");
  }
  // Registry rows carrying a wake the pending file doesn't know about (persisted
  // before durable wakeups shipped, or a lost debounce race) — backfill so
  // nothing silently drops. With both files healthy this loop is a no-op.
  for (const e of reg.values()) {
    if (e.wakeAt && !pend[e.sessionId]) {
      armWake(e.sessionId, {
        fireAt: e.wakeAt, reason: e.wakeReason, prompt: e.wakePrompt,
        toolId: e.wakeToolId, late: e.wakeAt <= now,
      }, "armed (boot backfill from run-registry snapshot)");
    }
  }
  _persist();
}

// Leak instrumentation (2026-07-24): cheap snapshot of retained per-run state so
// leak-trace.js can see if openTools accumulates on long/looping runs.
function _leakStats() {
  let openTools = 0, maxOpen = 0, maxSid = null;
  for (const [sid, e] of reg) {
    const n = e && e.openTools ? Object.keys(e.openTools).length : 0;
    openTools += n;
    if (n > maxOpen) { maxOpen = n; maxSid = sid; }
  }
  return { sessions: reg.size, openTools, maxOpen, maxSid: maxSid ? maxSid.slice(0,8) : null };
}

module.exports = {
  runStarted, streamActivity, tap, runEnded, getEntry, clearWake, dueWakes,
  armWake, disarmWake,
  sessionRunState, sampleForWedge, loadRegistry, toolBudgetMs,
  REGISTRY_PATH, PENDING_WAKEUPS_PATH, _leakStats,
};

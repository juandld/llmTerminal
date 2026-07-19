// attention.js — "call for David" routing (2026-07-19). The system pushes
// "you're needed" to David instead of waiting in a sidebar; this module is the
// shared plumbing for the three push features:
//   A. token-limit protocol   — a session/usage-limit api_error arms an
//      auto-resume wake at reset+7min (via run-registry armWake, the SAME
//      setter the ScheduleWakeup tool path uses, so pending-wakeups.json
//      persistence + wake-sweep + governor gating all apply) and files a
//      low-urgency secretary item ("nothing needed, auto-resume armed").
//   B. dead-run auto-continuation — a run that died mid-task is revived
//      through the normal queue machinery (queueAppend source:"wake" +
//      tryDrainQueue), UNLESS the death was our own user-message replacement
//      kill (<15s mark from killExistingClaudeFor). Hard cap 2 revives per
//      session per 6h (memory + persisted-message scan) with a high-urgency
//      secretary escalation on the second death.
//   C. contract-check needs-you routing — supervisors.js imports
//      postSecretaryItem() to file the judge's needs_david_now verdicts.
//
// Secretary contract (orchestratorHero POST /api/secretary/items):
//   { source_type:"session", source_id:<llmT session id>, title, observation,
//     opinion, ask, urgency:"high"|"normal", action_url:"/terminal/#<id>",
//     attention_minutes:<int> }
// Every POST is wrapped so attention routing can NEVER break the run pipeline:
// failures are one console.warn line, nothing propagates.
const { loadMessages, loadSessions } = require("./store");
const { queueAppend } = require("./queue");
const runReg = require("./run-registry");
const governor = require("./governor");

const SECRETARY_URL = process.env.LLMT_SECRETARY_URL || "http://localhost:8000/api/secretary/items";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function _sessionTitle(sessionId) {
  try {
    const s = loadSessions().find(x => x.id === sessionId);
    if (s && s.title) return String(s.title).slice(0, 120);
  } catch {}
  return String(sessionId || "").slice(0, 8);
}

// ---- shared secretary poster ----
// Fire-and-forget: returns a promise resolving true/false, never rejects,
// never throws. The orchestrator backend owns delivery (Telegram etc.).
function postSecretaryItem({ sessionId, title, ask, observation, opinion, urgency, attentionMinutes }) {
  try {
    const body = {
      source_type: "session",
      source_id: String(sessionId || ""),
      title: String(title || "").slice(0, 200),
      observation: String(observation || "").slice(0, 1000),
      opinion: String(opinion || "").slice(0, 1000),
      ask: String(ask || "").slice(0, 500),
      urgency: urgency === "high" ? "high" : "normal",
      action_url: "/terminal/#" + String(sessionId || ""),
      attention_minutes: Number.isFinite(attentionMinutes) ? Math.round(attentionMinutes) : 4,
    };
    return fetch(SECRETARY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(5000) : undefined,
    }).then(async (r) => {
      if (r && r.ok) {
        console.log("[secretary] item posted (" + body.urgency + "):", body.title.slice(0, 80));
        return true;
      }
      let detail = "";
      try { detail = (await r.text()).slice(0, 200); } catch {}
      console.warn("[secretary] item POST rejected (" + (r && r.status) + "):", body.title.slice(0, 80), detail);
      return false;
    }).catch((e) => {
      console.warn("[secretary] item POST failed (attention routing skipped):", e.message);
      return false;
    });
  } catch (e) {
    console.warn("[secretary] item POST threw (attention routing skipped):", e.message);
    return Promise.resolve(false);
  }
}

// ---- Feature A: token-limit protocol ----
// Detects the CLI's session/usage-limit result text, e.g.:
//   "You've hit your session limit · resets 12:10am (UTC)"
//   "Claude usage limit reached. Your limit will reset at 4:30pm (UTC)."
//   "You've hit your usage limit · resets 4pm"
// The reset clock time is UTC whether or not "(UTC)" is present. NOT matched:
// transient rate limits ("rate limit", 429s) — those belong to the retry path.
const USAGE_LIMIT_RE = /\b(?:session|usage)\s+limit\b/i;
const RESET_TIME_RE = /\breset(?:s)?\b(?:\s+at)?\s+(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/i;
const TOKEN_LIMIT_WAKE_DELAY_MS = 7 * 60 * 1000;
const TOKEN_LIMIT_RESUME_PROMPT =
  "Your previous run hit the session token limit; the limit has reset. " +
  "Resume the interrupted task exactly where it stopped.";
const _tokenLimitLastFire = new Map(); // sessionId -> ts of last wake+item (6h dedupe)

function _hhmmUtc(ms) {
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}

// Returns { resetAtMs } (next FUTURE occurrence of the parsed UTC clock time,
// rolling past midnight when needed) or null when the text isn't a
// session/usage-limit message with a parseable h[:mm]am/pm reset time.
function parseUsageLimitReset(text, nowMs = Date.now()) {
  const s = String(text || "");
  if (!USAGE_LIMIT_RE.test(s)) return null;
  const m = RESET_TIME_RE.exec(s);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h < 1 || h > 12) return null;
  const pm = m[3].toLowerCase() === "pm";
  if (pm) h = h === 12 ? 12 : h + 12;
  else h = h === 12 ? 0 : h;
  const d = new Date(nowMs);
  let resetAtMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min, 0, 0);
  if (resetAtMs <= nowMs) resetAtMs += 24 * 60 * 60 * 1000;
  return { resetAtMs };
}

// Called from BOTH api_error paths (headless + WS) on every api_error result.
// No-op unless the text is a parseable session/usage-limit message. At most
// one wake+item per session per 6h. nowMs is injectable for tests.
function handleTokenLimitError(sessionId, resultText, nowMs = Date.now()) {
  try {
    if (!sessionId) return null;
    const parsed = parseUsageLimitReset(resultText, nowMs);
    if (!parsed) return null;
    // Calibrate the pace engine on EVERY observed hit — before the per-session
    // 6h dedupe below (ceilings want each observation; pace dedupes its own
    // file writes). Lazy require + catch: calibration can never break the run
    // pipeline.
    try { require("./pace").recordLimitHit({ resetAtMs: parsed.resetAtMs, text: resultText, nowMs }); } catch {}
    const sid8 = String(sessionId).slice(0, 8);
    const lastFire = _tokenLimitLastFire.get(sessionId) || 0;
    if (nowMs - lastFire < SIX_HOURS_MS) {
      console.log("[token-limit] deduped for", sid8, "— wake+item already armed",
        Math.round((nowMs - lastFire) / 60000) + "min ago (max 1 per 6h)");
      return { deduped: true };
    }
    const wakeAt = parsed.resetAtMs + TOKEN_LIMIT_WAKE_DELAY_MS;
    // The SAME setter the ScheduleWakeup tool path uses (run-registry tap →
    // armWake): in-memory wake fields + pending-wakeups.json in one motion,
    // so the wake survives restarts and the wake-sweep owns the re-fire.
    runReg.armWake(sessionId, {
      fireAt: wakeAt,
      reason: "token-limit auto-resume (limit resets " + _hhmmUtc(parsed.resetAtMs) + " UTC)",
      prompt: TOKEN_LIMIT_RESUME_PROMPT,
      toolId: null,
    }, "armed (token-limit auto-resume)");
    _tokenLimitLastFire.set(sessionId, nowMs);
    console.log("[token-limit]", sid8, "hit its token ceiling — auto-resume wake armed for",
      _hhmmUtc(wakeAt), "UTC (reset " + _hhmmUtc(parsed.resetAtMs) + " + 7min)");
    postSecretaryItem({
      sessionId,
      urgency: "normal",
      title: "Chat hit token ceiling: " + _sessionTitle(sessionId),
      observation: "Run ended with: " + String(resultText || "").replace(/\s+/g, " ").trim().slice(0, 200),
      ask: "Nothing needed — auto-resume armed for " + _hhmmUtc(wakeAt) + " UTC; reopen only if you want it sooner.",
      attentionMinutes: 1,
    });
    return { armed: true, wakeAt };
  } catch (e) {
    console.warn("[token-limit] handler failed (run pipeline unaffected):", e.message);
    return null;
  }
}

// ---- Feature B: dead-run auto-continuation ----
const REPLACE_KILL_WINDOW_MS = 15 * 1000;
const AUTO_CONTINUE_MAX_PER_WINDOW = 2;
const AUTO_CONTINUE_PREFIX = "Your previous run died mid-task";
const _replaceKills = new Map();      // claudeSessionId -> ts of our replacement kill
const _autoContinueFires = new Map(); // sessionId -> [ts, ...] of revives fired

// Called by killExistingClaudeFor right before it SIGTERMs the old CLI proc:
// a death observed within 15s of this mark is OUR kill — the user's new
// message is the continuation, so the auto-continuer must stand down.
function noteReplaceKill(claudeSessionId) {
  if (!claudeSessionId) return;
  _replaceKills.set(claudeSessionId, Date.now());
}
function wasRecentReplaceKill(claudeSessionId, nowMs = Date.now()) {
  if (!claudeSessionId) return false;
  const ts = _replaceKills.get(claudeSessionId);
  return !!ts && (nowMs - ts) < REPLACE_KILL_WINDOW_MS;
}

// Revives-in-window = max(in-memory fires, persisted source:"wake"
// auto-continuation user messages). The message scan survives server
// restarts, so a crash-looping session can't be revived forever by
// wiping in-memory state with each crash of the server itself.
function _countRecentAutoContinues(sessionId, nowMs) {
  const mem = (_autoContinueFires.get(sessionId) || []).filter(ts => nowMs - ts < SIX_HOURS_MS);
  _autoContinueFires.set(sessionId, mem);
  let persisted = 0;
  try {
    persisted = loadMessages(sessionId).filter(m =>
      m && m.role === "user" && m.source === "wake" &&
      typeof m.text === "string" && m.text.startsWith(AUTO_CONTINUE_PREFIX) &&
      (m.ts || 0) > nowMs - SIX_HOURS_MS
    ).length;
  } catch (e) { console.warn("[auto-continue] message scan failed:", e.message); }
  return Math.max(mem.length, persisted);
}

// Called from the two places that observe a mid-run death: providers/claude.js
// fireQueueHeadless onClose (!gotResult) and server.js sweepStalledSessions
// (dead_mid_run). info = { claudeSessionId, exitCode, cause:"exit"|"stalled",
// now? (test injection) }.
function handleDeadRun(sessionId, info = {}) {
  try {
    if (!sessionId) return null;
    const nowMs = info.now || Date.now();
    const sid8 = String(sessionId).slice(0, 8);
    const detail = info.cause === "stalled" ? "stalled"
      : "exit " + (info.exitCode == null ? "?" : info.exitCode);
    if (wasRecentReplaceKill(info.claudeSessionId, nowMs)) {
      console.log("[auto-continue] SKIP for", sid8, "— death was a user-message replacement kill (<15s);",
        "the user's own message is the continuation");
      return { skipped: "replace-kill" };
    }
    const prior = _countRecentAutoContinues(sessionId, nowMs);
    if (prior >= AUTO_CONTINUE_MAX_PER_WINDOW) {
      console.warn("[auto-continue] CAP suppressed revive for", sid8, "—", prior,
        "auto-continuations already in the last 6h (" + detail + ");",
        "crash-looping session stays down until David reopens it");
      return { skipped: "cap", prior };
    }
    // Machine-initiated spawn → governor-gated, matching the wake-sweep's
    // contract (everything entering the queue as source:"wake" was gated by
    // its enqueuer). Parked = no revive AND no cap consumed.
    const gv = governor.check("llmterminal-auto");
    if (!gv.ok) {
      console.warn("[auto-continue] parked by governor for", sid8, "—", gv.reason);
      return { skipped: "governor" };
    }
    const text = AUTO_CONTINUE_PREFIX + " (" + detail + "). Check for interrupted background work — " +
      "for Workflows read the journal and relaunch with resumeFromRunId; " +
      "otherwise continue the task from its last state.";
    queueAppend(sessionId, { text, source: "wake", ts: nowMs });
    const mem = _autoContinueFires.get(sessionId) || [];
    mem.push(nowMs);
    _autoContinueFires.set(sessionId, mem);
    const fireNo = prior + 1;
    console.log("[auto-continue] FIRED revive", fireNo, "of", AUTO_CONTINUE_MAX_PER_WINDOW,
      "for", sid8, "(" + detail + ")");
    if (fireNo === AUTO_CONTINUE_MAX_PER_WINDOW) {
      postSecretaryItem({
        sessionId,
        urgency: "high",
        title: "Chat keeps dying mid-task: " + _sessionTitle(sessionId),
        observation: "Second mid-run death (" + detail + ") within 6h; revive #2 just queued. " +
          "This pattern usually means the task cannot self-heal.",
        ask: "Two auto-revives failed — open it and look.",
        attentionMinutes: 5,
      });
    }
    // Lazy require: providers/claude requires this module (via supervisors +
    // directly), so a top-level require here would be circular. By the time a
    // dead run is handled, the module graph is long settled.
    try { require("./providers/claude").tryDrainQueue(sessionId); }
    catch (e) { console.error("[auto-continue] drain failed:", e.message); }
    return { fired: fireNo };
  } catch (e) {
    console.warn("[auto-continue] handler failed (run pipeline unaffected):", e.message);
    return null;
  }
}

// Test hook: clears the in-memory dedupe/cap/kill-mark state (harness only).
function _testReset() {
  _tokenLimitLastFire.clear();
  _replaceKills.clear();
  _autoContinueFires.clear();
}

module.exports = {
  postSecretaryItem,
  parseUsageLimitReset, handleTokenLimitError,
  noteReplaceKill, wasRecentReplaceKill, handleDeadRun,
  SECRETARY_URL, AUTO_CONTINUE_PREFIX, TOKEN_LIMIT_RESUME_PROMPT,
  _testReset,
};

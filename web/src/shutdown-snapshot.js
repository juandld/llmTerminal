// shutdown-snapshot.js — restart coordination (loop-hardening WS1b, 2026-07-04).
//
// A /restart of llm-terminal SIGTERMs the server; after the 60s grace window
// systemd SIGKILLs any claude subprocess still running (observed 2026-07-03
// 16:59:28 — two claude procs killed, the loop session's run died mid-tool).
// gracefulShutdown writes the ids of sessions with a live run here; startup
// recovery consumes the file and unions it with its own unanswered scan. The
// snapshot's ONLY privilege is bypassing the 30s "too fresh" skip — every
// candidate still passes the same answered-ness guard (recoveryCandidate
// below), so an already-answered prompt is never re-fired.
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const SNAPSHOT_PATH = path.join(DATA_DIR, "shutdown-snapshot.json");

// write-then-rename, same crash-safety as pending-wakeups.json. Called twice
// per shutdown: at SIGTERM (crash-safe baseline) and after the drain wait
// (runs that drained cleanly answered their prompt and drop out of the file).
function writeSnapshot(sessionIds, reason) {
  try {
    const ids = [...(sessionIds || [])].filter((x) => typeof x === "string");
    const tmp = SNAPSHOT_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), reason: String(reason || ""), sessions: ids }, null, 2));
    fs.renameSync(tmp, SNAPSHOT_PATH);
    console.log("[shutdown] snapshot (" + reason + "): " + ids.length + " active run(s)" +
      (ids.length ? " — " + ids.map((i) => String(i).slice(0, 8)).join(", ") : ""));
  } catch (e) { console.error("[shutdown] snapshot write failed:", e.message); }
}

// Read + delete. Returns the Set of session ids that were mid-run at the last
// shutdown; empty Set when there is no snapshot (clean boot, or pre-snapshot
// build). Consumed exactly once so a snapshot can never re-fire twice.
function consumeSnapshot() {
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")); }
  catch { return new Set(); }
  try { fs.unlinkSync(SNAPSHOT_PATH); } catch {}
  const ids = Array.isArray(snap && snap.sessions) ? snap.sessions.filter((x) => typeof x === "string") : [];
  if (ids.length) {
    console.log("[startup-recovery] shutdown snapshot: " + ids.length + " session(s) killed mid-run at " +
      new Date(snap.at || 0).toISOString() + " (" + (snap.reason || "?") + ")");
  }
  return new Set(ids);
}

// Decide whether a session needs a boot-time re-fire of its last user prompt.
// This owns the startup-recovery answered-ness guard: the most-recent user
// message must have no real assistant response after it. A stalled marker does
// NOT count as an answer; an `interrupted` row DOES (the user deliberately
// killed that run) — same rule as ws/connection.js auto-retry and the
// providers/claude.js rate-limit retry guard. `wasKilledMidRun` (from the
// shutdown snapshot) only bypasses the 30s freshness skip: after a restart
// nothing can "still be running", the proc was provably SIGKILLed.
function recoveryCandidate(msgs, opts = {}) {
  const now = opts.now || Date.now();
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return { recover: false, why: "no user message" };
  const after = msgs.slice(lastUserIdx + 1);
  if (after.some((m) => (m.role === "assistant" && !m.stalled) || m.role === "interrupted")) {
    return { recover: false, why: "already answered", lastUserIdx };
  }
  if (now - (msgs[lastUserIdx].ts || 0) < 30000 && !opts.wasKilledMidRun) {
    return { recover: false, why: "too fresh, might still be running", lastUserIdx };
  }
  return { recover: true, why: opts.wasKilledMidRun ? "unanswered, killed mid-run at shutdown" : "unanswered", lastUserIdx };
}

module.exports = { writeSnapshot, consumeSnapshot, recoveryCandidate, SNAPSHOT_PATH };

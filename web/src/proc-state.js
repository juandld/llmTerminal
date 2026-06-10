// Shared process-tracking state for in-flight provider/Claude runs.
// Extracted from server.js (refactor 2026-06-10, phase 12). Exported by
// reference (Set/Map mutated in place by runners, queue-drain, WS handler).
const activeProcs = new Set();
// Session-level busy state for queue draining. sessionId -> running child proc.
// Distinct from the per-WS `activeProc` closure: a run outlives the WS that
// started it (mobile backgrounds the tab mid-turn, the WS drops, but claude keeps
// going), so "is this session busy?" must be answered per-session, not
// per-connection. tryDrainQueue and the prompt handler consult this so a
// reconnected WS neither double-spawns nor strands queued items. Cleared in each
// run's onDone (process close).
const activeProcBySession = new Map();

module.exports = { activeProcs, activeProcBySession };

// autoloop.js — shared constants/prompt-builder for native autoloop recurrence.
// Split out of server.js (2026-08-23 fix) so run-registry's runStarted() can
// re-arm the same prompt text that sweepDueWakes uses, instead of the wake
// silently dying on the next turn (see HARNESS_PLAN.md progress log).
const AUTOLOOP_MIN_INTERVAL_MS = 60 * 1000;      // matches ScheduleWakeup's own floor
const AUTOLOOP_MAX_INTERVAL_MS = 60 * 60 * 1000; // 1h ceiling — sanity bound, not a hard product limit

function autoloopPrompt(intervalMs) {
  const minutes = Math.round(intervalMs / 60000);
  return "[Autoloop — server-recurring every " + minutes + " min, no ScheduleWakeup needed]\n\n" +
    "Continue working. Read HARNESS_PLAN.md's progress log and /api/autoloop-log's openQuestions " +
    "first — close a genuine open question before starting new work (never-idle rule). If a numbered " +
    "slot is still todo, ship ONE concrete, verified piece of it. If everything is shipped/decided/deferred " +
    "and quiet, do a light state check (server up, harness-plan state) rather than manufacture busywork. " +
    "UI changes need real Playwright verification — steps are enforced code gates, not notes (see " +
    "HARNESS_PLAN.md 'Enforced steps'). This wake will re-arm itself automatically at the same interval " +
    "after you respond — you do not need to call ScheduleWakeup. To stop the loop, David turns it off via " +
    "the topbar autoloop menu (or you can defer to him if he asks).";
}

module.exports = { AUTOLOOP_MIN_INTERVAL_MS, AUTOLOOP_MAX_INTERVAL_MS, autoloopPrompt };

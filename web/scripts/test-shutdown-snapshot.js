#!/usr/bin/env node
// test-shutdown-snapshot.js — simulate the restart-coordination lifecycle
// (loop-hardening WS1b) against a THROWAWAY data dir: SIGTERM snapshot write →
// post-drain rewrite → server "restart" (module reload) → consume-once →
// recovery candidacy through the answered-ness guard.
//
// Run: node web/scripts/test-shutdown-snapshot.js
// Safe to run next to the live server: paths.js is stubbed to a tmp dir before
// shutdown-snapshot is loaded, so the real ~/.llm-terminal is never touched.
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmt-shutdown-test-"));
const pathsId = require.resolve("../src/paths.js");
require.cache[pathsId] = {
  id: pathsId, filename: pathsId, loaded: true,
  exports: {
    PROJECTS_DIR: tmp, DATA_DIR: tmp,
    SESSIONS_FILE: path.join(tmp, "sessions.json"),
    MESSAGES_DIR: tmp, CLAUDE_PROJECTS_DIR: tmp,
    MESSAGES_DB_PATH: path.join(tmp, "messages.db"),
  },
};
const snapId = require.resolve("../src/shutdown-snapshot.js");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS" : "  FAIL") + " — " + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
}
const snapshotPath = path.join(tmp, "shutdown-snapshot.json");

const KILLED = "sess-killed-mid-run-1111";
const DRAINED = "sess-drained-clean-2222";

console.log("== phase 1: SIGTERM — snapshot written, then post-drain rewrite ==");
let snap = require(snapId);
// SIGTERM arrives with two live runs (what gracefulShutdown sees at signal time)
snap.writeSnapshot(new Map([[KILLED, {}], [DRAINED, {}]]).keys(), "SIGTERM");
let onDisk = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
check("SIGTERM snapshot lists both active sessions",
  onDisk.sessions.length === 2 && onDisk.sessions.includes(KILLED) && onDisk.sessions.includes(DRAINED));
check("snapshot carries {at, reason}", typeof onDisk.at === "number" && onDisk.reason === "SIGTERM");
// DRAINED finishes inside the 60s grace window; the post-drain rewrite drops it
snap.writeSnapshot(new Map([[KILLED, {}]]).keys(), "SIGTERM post-drain");
onDisk = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
check("post-drain rewrite keeps only the run systemd will SIGKILL",
  onDisk.sessions.length === 1 && onDisk.sessions[0] === KILLED);

console.log("== phase 2: 'restart' — fresh module instance consumes exactly once ==");
delete require.cache[snapId];
snap = require(snapId);
const killedSet = snap.consumeSnapshot();
check("consume returns the killed session", killedSet.size === 1 && killedSet.has(KILLED));
check("snapshot file deleted on consume", !fs.existsSync(snapshotPath));
check("second consume (double boot) is empty — never re-fires twice", snap.consumeSnapshot().size === 0);

console.log("== phase 3: recovery candidacy — union routed through the answered-ness guard ==");
const now = Date.now();
const user = (ts, text) => ({ role: "user", text: text || "do the thing", ts });
const tool = (ts) => ({ role: "tool_activity", ts });
const asst = (ts, extra) => Object.assign({ role: "assistant", text: "done", ts }, extra);

// 1. The 16:59 shape: wake/user prompt seconds before the kill, run died mid-tool.
//    Without the snapshot the 30s freshness skip drops it; the snapshot bypasses it.
let c = snap.recoveryCandidate([user(now - 10000), tool(now - 5000)], { wasKilledMidRun: true, now });
check("killed mid-run + fresh prompt → RECOVER (snapshot bypasses freshness skip)", c.recover === true, c.why);
c = snap.recoveryCandidate([user(now - 10000), tool(now - 5000)], { wasKilledMidRun: false, now });
check("same messages, no snapshot → skipped as too fresh (scan unchanged)",
  c.recover === false && /fresh/.test(c.why), c.why);

// 2. Guard holds even for snapshot sessions: an answered prompt is never re-fired.
c = snap.recoveryCandidate([user(now - 300000), asst(now - 200000)], { wasKilledMidRun: true, now });
check("killed mid-run but prompt already answered → NOT re-fired (answered-ness guard)",
  c.recover === false && c.why === "already answered", c.why);

// 3. A stalled marker over the user prompt does not count as an answer.
c = snap.recoveryCandidate([user(now - 300000), tool(now - 250000), asst(now - 100000, { stalled: true })],
  { wasKilledMidRun: true, now });
check("stalled marker ≠ answer → RECOVER", c.recover === true, c.why);

// 4. `interrupted` counts as answered — the user deliberately killed that run
//    (same rule as ws/connection.js auto-retry and the claude.js retry guard).
c = snap.recoveryCandidate([user(now - 300000), { role: "interrupted", ts: now - 250000 }],
  { wasKilledMidRun: true, now });
check("interrupted counts as answered → NOT re-fired", c.recover === false, c.why);

// 5. Plain scan path (no snapshot) still recovers an old unanswered prompt.
c = snap.recoveryCandidate([user(now - 300000), tool(now - 250000)], { wasKilledMidRun: false, now });
check("old unanswered prompt, no snapshot → RECOVER (existing behavior kept)", c.recover === true, c.why);

// 6. Nothing to re-fire without a user message.
c = snap.recoveryCandidate([asst(now - 300000)], { wasKilledMidRun: true, now });
check("no user message → skip", c.recover === false && c.why === "no user message", c.why);

console.log(failures === 0 ? "\nALL CHECKS PASSED (" + tmp + ")" : "\n" + failures + " CHECK(S) FAILED");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

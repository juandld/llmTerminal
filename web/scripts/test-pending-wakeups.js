#!/usr/bin/env node
// test-pending-wakeups.js — simulate the durable-wakeup lifecycle (loop-hardening WS1a)
// against a THROWAWAY data dir: arm → persist → server "restart" (module reload)
// → boot re-arm (future + past-due-late) → supersede → fire.
//
// Run: node web/scripts/test-pending-wakeups.js
// Safe to run next to the live server: paths.js is stubbed to a tmp dir before
// run-registry is loaded, so the real ~/.llm-terminal is never touched.
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmt-wakeup-test-"));
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
const regId = require.resolve("../src/run-registry.js");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS" : "  FAIL") + " — " + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
}
const pendingPath = path.join(tmp, "pending-wakeups.json");
const readPending = () => JSON.parse(fs.readFileSync(pendingPath, "utf8"));

(async () => {
  const A = "sessA-loop-1111", B = "sessB-loop-2222";

  console.log("== phase 1: arm via the live tap path (instance 1) ==");
  let reg = require(regId);
  reg.runStarted(A, null, "claude");
  reg.tap(A, { type: "assistant", message: { content: [{
    type: "tool_use", id: "tu_1", name: "ScheduleWakeup",
    input: { delaySeconds: 600, reason: "loop iteration", prompt: "Continue the overnight loop." },
  }] } });
  let pend = readPending();
  const firedAtA = pend[A] && pend[A].fire_at;
  check("tap(ScheduleWakeup) persisted pending entry for A", !!pend[A]);
  check("entry has {session_id, fire_at, prompt, armed_at}",
    pend[A] && pend[A].session_id === A && typeof pend[A].fire_at === "number" &&
    pend[A].prompt === "Continue the overnight loop." && typeof pend[A].armed_at === "number");
  check("fire_at ~ now+600s", Math.abs(pend[A].fire_at - (Date.now() + 600000)) < 5000);

  // B: a wake that was due 5 min ago when the "server died" (armed directly —
  // same single arm path the tap uses).
  reg.armWake(B, { fireAt: Date.now() - 5 * 60 * 1000, reason: "past-due loop", prompt: "Resume B." });
  pend = readPending();
  check("past-due wake B persisted too", !!pend[B]);

  await new Promise(r => setTimeout(r, 1200)); // let the debounced run-registry.json snapshot land

  console.log("== phase 2: 'restart' — fresh module instance, loadRegistry() re-arms ==");
  delete require.cache[regId];
  reg = require(regId);
  check("fresh instance starts empty (pre-boot)", reg.dueWakes(Number.MAX_SAFE_INTEGER).length === 0);
  reg.loadRegistry();
  const eA = reg.getEntry(A), eB = reg.getEntry(B);
  check("A re-armed with the persisted fire_at", !!eA && eA.wakeAt === firedAtA);
  check("A is future, not late", !!eA && eA.wakeLate === false && eA.wakeAt > Date.now());
  check("B re-armed flagged late:true", !!eB && eB.wakeLate === true);
  const due = reg.dueWakes(Date.now());
  check("dueWakes() = [B] (past-due fires now, A waits)", due.length === 1 && due[0].sessionId === B);
  check("A's prompt survived the restart", !!eA && eA.wakePrompt === "Continue the overnight loop.");

  console.log("== phase 3: supersede + fire clear the persisted entries ==");
  reg.runStarted(A, null, "claude"); // real user turn before A's wake fired
  pend = readPending();
  check("new turn superseded A's wake (entry removed)", !pend[A]);
  reg.clearWake(B, "late-fired");    // what sweepDueWakes calls on fire
  pend = readPending();
  check("firing B removed its entry — file empty", Object.keys(pend).length === 0);

  console.log(failures === 0 ? "\nALL CHECKS PASSED (" + tmp + ")" : "\n" + failures + " CHECK(S) FAILED");
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
})();

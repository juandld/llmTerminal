#!/usr/bin/env node
// test-loop-check.js — end-to-end check of spawnLoopCheck (Layer B of the
// 2026-08-23 orchestrator-loop-continuation fix): a session that spawns a
// queue task via curl and then ends its turn on "ping me status" language
// must get a wake armed ~90s later that resumes it and tells it to check +
// integrate the result. A session that awaited its subtask must NOT.
//
// Runs against a THROWAWAY data dir (paths.js stubbed before any module that
// touches storage is required) — never touches the live ~/.llm-terminal.
// Hits the REAL haiku CLI via cheap-model.js (same call path production uses)
// — no mocking of the classifier itself.
//
// Run: node web/scripts/test-loop-check.js
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmt-loopcheck-test-"));
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

const { saveMessage, saveSessions } = require("../src/store");
const runReg = require("../src/run-registry");
const { spawnLoopCheck } = require("../src/supervisors");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS" : "  FAIL") + " — " + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
}

function seedSession(id, msgs) {
  saveSessions([{ id, project: "orchestratorhero", title: "test" }]);
  let ts = Date.now() - msgs.length * 1000;
  for (const m of msgs) saveMessage(id, { ...m, ts: ts++ });
}

async function waitForWakeOrTimeout(sessionId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const e = runReg.getEntry(sessionId);
    if (e && e.wakeAt) return e;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

(async () => {
  console.log("== case 1: spawn-then-yield (the voice-note complaint pattern) ==");
  const YIELD_ID = "loopcheck-yield-0001";
  seedSession(YIELD_ID, [
    { role: "user", text: "Find the top DM candidates in Calabria and dispatch the outreach." },
    { role: "assistant", text: "On it." },
    { role: "tool_activity", tool_name: "Bash", summary: "curl -X POST http://localhost:8000/api/orchestrator/queue/create -d '{\"title\":\"DM outreach batch\"}'" },
    { role: "assistant", text: "Queue task 9f2a1c dispatched to camoHero for the DM batch. I'll surface the results when it lands — ping me any time for status." },
  ]);
  spawnLoopCheck(YIELD_ID, "orchestratorhero");
  const yieldEntry = await waitForWakeOrTimeout(YIELD_ID, 45000);
  check("wake armed for the spawn+yield session", !!yieldEntry, yieldEntry ? "fireAt=" + new Date(yieldEntry.wakeAt).toISOString() : "timed out waiting on haiku classifier");
  if (yieldEntry) {
    check("wake fires ~90s out (not immediate, not far)", yieldEntry.wakeAt > Date.now() + 60000 && yieldEntry.wakeAt < Date.now() + 150000);
    check("resume prompt tells the agent to check status + integrate, not wait passively",
      /check its status now/i.test(yieldEntry.wakePrompt || "") && /do not end the turn with 'ping me'/i.test(yieldEntry.wakePrompt || ""));
  }

  console.log("\n== case 2: spawned but awaited in-turn (no anti-pattern) ==");
  const AWAIT_ID = "loopcheck-await-0002";
  seedSession(AWAIT_ID, [
    { role: "user", text: "Find the top DM candidates in Calabria and dispatch the outreach." },
    { role: "assistant", text: "On it." },
    { role: "tool_activity", tool_name: "Bash", summary: "curl -X POST http://localhost:8000/api/orchestrator/queue/create -d '{\"title\":\"DM outreach batch\"}'; for i in $(seq 1 60); do ... done" },
    { role: "assistant", text: "Dispatched and waited for the queue task to finish — it sent 6 DMs. Full list is in development/dm_batch_20260814.json." },
  ]);
  spawnLoopCheck(AWAIT_ID, "orchestratorhero");
  await new Promise(r => setTimeout(r, 20000));
  const awaitEntry = runReg.getEntry(AWAIT_ID);
  check("no wake armed for the awaited-in-turn session", !awaitEntry || !awaitEntry.wakeAt, awaitEntry ? "wakeAt=" + awaitEntry.wakeAt : "no entry");

  console.log(failures === 0 ? "\nALL CHECKS PASSED (" + tmp + ")" : "\n" + failures + " CHECK(S) FAILED (" + tmp + ")");
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
})();

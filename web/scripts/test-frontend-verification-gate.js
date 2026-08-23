#!/usr/bin/env node
// test-frontend-verification-gate.js — proves gate (c) in spawnContractCheck
// (web/src/supervisors.js, "Gate (c): frontend claim without browser
// verification") actually blocks the failure mode it exists to catch: a
// turn edits web/public/*.js or styles.css, claims success, but the only
// tool evidence is curl (or nothing) — no real Playwright browser pass.
//
// This is the concrete incident: the DeepSeek-provider picker bug
// (2026-08-23) — backend verified via curl and reported LIVE, but the
// frontend never rendered it (4 hardcoded provider arrays). David's
// response: "We're not logging shit... we are implementing steps — steps
// that if not followed means it is still not complete." This test proves
// the step is an enforced block, not a note.
//
// Runs against a THROWAWAY data dir (paths.js stubbed before any module
// that touches storage is required) — never touches the live ~/.llm-terminal.
// Gate (c) returns synchronously BEFORE any Haiku call in the bad case, so
// no live model dependency for that assertion. The good case falls through
// to the rest of spawnContractCheck (which may fire a real Haiku judge
// call, same as production) — we only assert on gate (c)'s own message,
// checked synchronously right after the call returns.
//
// Run: node web/scripts/test-frontend-verification-gate.js
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmt-frontendgate-test-"));
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

const { saveMessage, saveSessions, loadMessages } = require("../src/store");
const { spawnContractCheck } = require("../src/supervisors");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS" : "  FAIL") + " — " + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
}

function seedSession(id, msgs) {
  // No .git dir in tmp — gate (a)/(b)'s git-status check silently no-ops
  // (existsSync(".git") is false), so only gate (c) is under test here.
  saveSessions([{ id, project: "llmterminal", title: "test" }]);
  let ts = Date.now() - msgs.length * 1000;
  for (const m of msgs) saveMessage(id, { ...m, ts: ts++ });
}

function hasFrontendUnverifiedWarning(id) {
  return loadMessages(id).some(m => m.source === "contract_check_frontend_unverified");
}

console.log("== case 1: frontend edit + success claim, curl-only evidence (the actual incident) ==");
const BAD_ID = "frontendgate-bad-0001";
seedSession(BAD_ID, [
  { role: "user", text: "Add DeepSeek to the provider list." },
  { role: "tool_activity", tool_name: "Edit", summary: "/home/claude-user/projects/llmTerminal/web/public/app-modelpicker.js" },
  { role: "tool_activity", tool_name: "Bash", summary: "curl -sS http://localhost:7683/api/models" },
  { role: "assistant", text: "DeepSeek provider shipped (uncommitted, LIVE). DeepSeek is now a first-class provider that appears in the model picker." },
]);
spawnContractCheck(BAD_ID, "llmterminal");
check("gate (c) blocks — warning message present", hasFrontendUnverifiedWarning(BAD_ID));
const badManualDone = require("../src/store").loadSessions().find(s => s.id === BAD_ID)?.manualDone;
check("manualDone NOT set on the blocked session", !badManualDone);

console.log("\n== case 2: frontend edit + success claim, REAL Playwright navigate+observe ==");
const GOOD_ID = "frontendgate-good-0002";
seedSession(GOOD_ID, [
  { role: "user", text: "Add DeepSeek to the provider list." },
  { role: "tool_activity", tool_name: "Edit", summary: "/home/claude-user/projects/llmTerminal/web/public/app-modelpicker.js" },
  { role: "tool_activity", tool_name: "mcp__playwright__browser_navigate", summary: "http://localhost:7683/" },
  { role: "tool_activity", tool_name: "mcp__playwright__browser_take_screenshot", summary: "model-picker-deepseek.png" },
  { role: "assistant", text: "DeepSeek provider shipped and verified — screenshot confirms all 5 models render in the real picker." },
]);
spawnContractCheck(GOOD_ID, "llmterminal");
check("gate (c) does NOT block — no warning message", !hasFrontendUnverifiedWarning(GOOD_ID));

console.log("\n== case 3: frontend edit but NO success claim (mid-work, no false trigger) ==");
const NEUTRAL_ID = "frontendgate-neutral-0003";
seedSession(NEUTRAL_ID, [
  { role: "user", text: "Add DeepSeek to the provider list." },
  { role: "tool_activity", tool_name: "Edit", summary: "/home/claude-user/projects/llmTerminal/web/public/app-modelpicker.js" },
  { role: "assistant", text: "Still working through the picker rendering logic, will check back after the next edit." },
]);
spawnContractCheck(NEUTRAL_ID, "llmterminal");
check("gate (c) does NOT block — no claim of success made", !hasFrontendUnverifiedWarning(NEUTRAL_ID));

console.log("\n== case 4: backend-only edit + success claim, curl evidence (gate (c) must NOT apply) ==");
const BACKEND_ID = "frontendgate-backend-0004";
seedSession(BACKEND_ID, [
  { role: "user", text: "Add a DeepSeek pricing table." },
  { role: "tool_activity", tool_name: "Edit", summary: "/home/claude-user/projects/llmTerminal/web/src/pricing.js" },
  { role: "tool_activity", tool_name: "Bash", summary: "curl -sS http://localhost:7683/api/models" },
  { role: "assistant", text: "Pricing table shipped and live — curl confirms the rates load correctly." },
]);
spawnContractCheck(BACKEND_ID, "llmterminal");
check("gate (c) scoped to frontend files only — backend-only edit not blocked by THIS gate", !hasFrontendUnverifiedWarning(BACKEND_ID));

console.log(failures === 0 ? "\nALL CHECKS PASSED (" + tmp + ")" : "\n" + failures + " CHECK(S) FAILED (" + tmp + ")");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

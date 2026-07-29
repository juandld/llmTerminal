#!/usr/bin/env node
// Guards the self-restart deadlock fix (2026-07-29).
//
// An agent restarting llm-terminal from inside a run SIGTERMs its own parent;
// gracefulShutdown then waits for active subprocesses, of which the agent is
// one, and systemd SIGKILLs it 60s later — mid-reply. deferred-restart removes
// the choice: the restart is queued and fires only once no run is in flight.
//
//   node scripts/test-deferred-restart.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const WEB = path.join(__dirname, "..");
const dr = require(path.join(WEB, "src/deferred-restart.js"));
let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures++; console.error("  FAIL " + name + "\n       " + e.message); }
}

console.log("deferred-restart guards:");

check("rejects units the helper would not accept", () => {
  assert.strictEqual(dr.request({ unit: "nginx" }).ok, false);
  assert.strictEqual(dr.request({ unit: "" }).ok, false);
});

check("queues without blocking the caller", () => {
  const out = dr.request({ unit: "llm-terminal", reason: "guard" });
  assert(out.ok && out.queued, "request was not queued");
  assert(dr.status().pending, "nothing pending after a queued request");
});

check("repeat requests for the same unit collapse to one", () => {
  assert.strictEqual(dr.request({ unit: "llm-terminal" }).collapsed, true);
});

check("a different unit does not silently replace the queued one", () => {
  const out = dr.request({ unit: "cloudflared" });
  assert.strictEqual(out.ok, false, "second unit overwrote the pending restart");
  assert.strictEqual(dr.status().pending.unit, "llm-terminal");
});

// THE deadlock guard: while any run is live the restart must not fire.
check("holds while a run is active", () => {
  dr.tick(1);
  assert(dr.status().pending, "fired with an active run — this is the deadlock");
  dr.tick(3);
  assert(dr.status().pending, "fired with 3 active runs");
});

check("server wires the drain-watcher and the endpoint", () => {
  const srv = fs.readFileSync(path.join(WEB, "server.js"), "utf8");
  assert(/require\((["'])\.\/src\/deferred-restart\1\)/.test(srv), "module not required");
  assert(srv.includes("/api/deferred-restart"), "endpoint missing");
  assert(/deferredRestart\.tick\(activeProcs\.size\)/.test(srv),
    "tick() is not driven by the live subprocess count");
});

check("the restart skill documents the deferred path first", () => {
  const doc = "/home/claude-user/projects/orchestratorHero/.claude/commands/restart.md";
  if (!fs.existsSync(doc)) return; // sibling checkout absent (worktree/CI)
  const txt = fs.readFileSync(doc, "utf8");
  assert(txt.includes("/api/deferred-restart"), "skill does not mention the safe path");
  assert(txt.indexOf("/api/deferred-restart") < txt.indexOf("restart.sock"),
    "the deadlocking socket call is documented before the safe path");
});

// Do NOT leave a real restart queued behind.
dr.tick(1);
console.log(failures ? `\n${failures} FAILED` : "\nall guards passed");
process.exit(failures ? 1 : 0);

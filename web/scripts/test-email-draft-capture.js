#!/usr/bin/env node
// Regression guard for the 2026-07-29 lost-draft bug.
//
// What happened: draft capture existed ONLY in ws/connection.js. A prompt sent
// while no browser was attached runs through fireQueueHeadless() in
// providers/claude.js — a parallel copy of the same stream loop — which had no
// draft handling and stripped ```email-draft fences from the result text. A
// draft written on David's phone therefore existed nowhere: no card, no DB row,
// no NEEDS YOU badge.
//
// These checks fail if either runner stops routing drafts through the shared
// src/email-draft.js module, or if a THIRD runner appears without it.
//
//   node scripts/test-email-draft-capture.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const WEB = path.join(__dirname, "..");
let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures++; console.error("  FAIL " + name + "\n       " + e.message); }
}

console.log("email-draft capture guards:");

// ── 1. Both runners must delegate to the shared module ────────────────────
const RUNNERS = ["src/ws/connection.js", "src/providers/claude.js"];
for (const rel of RUNNERS) {
  const src = fs.readFileSync(path.join(WEB, rel), "utf8");
  check(`${rel} requires ../email-draft`, () => {
    assert(/require\((["']).*email-draft\1\)/.test(src), "no require of email-draft");
  });
  check(`${rel} captures MCP draft tool_results`, () => {
    assert(src.includes("captureToolResult"), "does not call captureToolResult");
    assert(src.includes("isDraftToolUse"), "does not track the draft tool_use id");
  });
  check(`${rel} captures ${"```"}email-draft fences`, () => {
    assert(src.includes("captureFences"), "does not call captureFences");
  });
  // The original sin: deleting the fence without saving what was inside it.
  check(`${rel} never strips a fence it did not capture`, () => {
    const strips = [...src.matchAll(/replace\(\s*\/```email-draft[\s\S]{0,80}?\/g\s*,\s*(["'])\1\s*\)/g)];
    for (const m of strips) {
      const before = src.slice(Math.max(0, m.index - 700), m.index);
      assert(before.includes("captureFences") || before.includes("_draftCapturedThisTurn"),
        "a bare fence-strip with no capture guard within 700 chars above it");
    }
  });
}

// ── 2. Persistence must not depend on a live socket ───────────────────────
const mod = fs.readFileSync(path.join(WEB, "src/email-draft.js"), "utf8");
check("emitDraft saves BEFORE it broadcasts", () => {
  const body = mod.slice(mod.indexOf("function emitDraft"));
  const save = body.indexOf("saveMessage");
  const bcast = body.indexOf("broadcastToSession");
  assert(save > -1 && bcast > -1, "missing saveMessage/broadcastToSession");
  assert(save < bcast, "broadcasts before persisting — a dead socket would lose the draft");
});
check("a broadcast failure cannot lose the draft", () => {
  const body = mod.slice(mod.indexOf("function emitDraft"));
  assert(/try\s*{[^}]*broadcastToSession/.test(body), "broadcast is not wrapped in try/catch");
});

// ── 3. Behavioural: capture works with no WebSocket in existence ───────────
// setWss() is never called here, so broadcastToSession is a no-op — exactly the
// headless case. The row must still land in the DB.
const emailDraft = require(path.join(WEB, "src/email-draft.js"));
const { loadMessages } = require(path.join(WEB, "src/store.js"));
const SID = "test-email-draft-" + process.pid;

check("MCP tool_result → persisted email_draft row (headless)", () => {
  const pending = new Set(["toolu_test_1"]);
  const payload = { type: "email_draft", to: "joi@crankwheel.com",
    subject: "guard subject", body: "guard body" };
  const out = emailDraft.captureToolResult(
    { type: "tool_result", tool_use_id: "toolu_test_1", content: JSON.stringify(payload) },
    pending, SID, "orchestratorHero");
  assert(out, "captureToolResult returned null");
  assert.strictEqual(out.session_id, SID, "draft missing session_id (frontend drops it)");
  assert.strictEqual(out.default_from_account, "crankwheel");
  const rows = loadMessages(SID).filter(m => m.role === "email_draft");
  assert.strictEqual(rows.length, 1, `expected 1 persisted draft, got ${rows.length}`);
  assert.strictEqual(rows[0].subject, "guard subject");
});

check("fence → persisted row + fence stripped from text", () => {
  const fence = "Here you go.\n\n```email-draft\n" +
    JSON.stringify({ to: "a@b.com", subject: "fenced", body: "x" }) + "\n```\n";
  const stripped = emailDraft.captureFences(fence, SID, "camoHero");
  assert.strictEqual(stripped, "Here you go.", "fence not stripped cleanly");
  const rows = loadMessages(SID).filter(m => m.role === "email_draft" && m.subject === "fenced");
  assert.strictEqual(rows.length, 1, "fenced draft was not persisted");
  assert.strictEqual(rows[0].default_from_account, "camofiles", "camoHero identity not applied");
});

check("incomplete payload is rejected, not half-saved", () => {
  const before = loadMessages(SID).filter(m => m.role === "email_draft").length;
  assert.strictEqual(emailDraft.emitDraft({ to: "a@b.com" }, SID, "crankHero"), null);
  const after = loadMessages(SID).filter(m => m.role === "email_draft").length;
  assert.strictEqual(after, before, "a draft with no subject/body was persisted anyway");
});

// ── 4. Tracking: a lost draft must never be silent again ──────────────────
for (const rel of RUNNERS) {
  const src = fs.readFileSync(path.join(WEB, rel), "utf8");
  check(`${rel} ledgers the draft request`, () => {
    assert(src.includes("noteRequested"), "does not record the draft request");
  });
  check(`${rel} reconciles pending drafts at end of run`, () => {
    assert(src.includes("emailDraft.reconcile("), "no reconcile() — a lost draft would be silent");
  });
}

check("reconcile marks lost drafts in ledger, journal AND chat", () => {
  const pending = new Set(["toolu_never_captured"]);
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  let n;
  try { n = emailDraft.reconcile(pending, SID, "orchestratorHero", "test-path"); }
  finally { console.error = realErr; }
  assert.strictEqual(n, 1, "reconcile did not report the lost draft");
  assert.strictEqual(pending.size, 0, "pending set not cleared");
  assert(errs.some(e => e.includes("LOST")), "nothing logged to the journal");
  const marker = loadMessages(SID).filter(m => m.synthetic === "email-draft-lost");
  assert.strictEqual(marker.length, 1, "the loss was not surfaced in the chat");
  const led = fs.readFileSync(emailDraft.LEDGER, "utf8").trim().split("\n");
  const last = JSON.parse(led[led.length - 1]);
  assert.strictEqual(last.event, "lost");
  assert.strictEqual(last.run_path, "test-path", "ledger does not record WHICH path lost it");
});

check("reconcile is a no-op when everything was captured", () => {
  const before = loadMessages(SID).filter(m => m.synthetic === "email-draft-lost").length;
  assert.strictEqual(emailDraft.reconcile(new Set(), SID, "crankHero", "test-path"), 0);
  const after = loadMessages(SID).filter(m => m.synthetic === "email-draft-lost").length;
  assert.strictEqual(after, before, "clean run produced a false loss alarm");
});

// Clean up the synthetic session's rows.
try {
  const { db } = require(path.join(WEB, "src/store.js"));
  db.prepare("DELETE FROM messages WHERE session_id = ?").run(SID);
} catch (e) { console.warn("  (cleanup skipped: " + e.message + ")"); }

console.log(failures ? `\n${failures} FAILED` : "\nall guards passed");
process.exit(failures ? 1 : 0);

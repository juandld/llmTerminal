#!/usr/bin/env node
// test-orchestrate-variant-wiring.js — proves the orchestrate A/B variant
// (assigned by web/src/experiments.js assignVariants, HARNESS_PLAN slot #3)
// actually causes a behavioral difference via _buildVariantPromptAdd in
// web/src/providers/claude.js (HARNESS_PLAN slot #6).
//
// The gap this closes: slot #3 was marked "shipped" — sessions get a
// variant stamped (session.variants.orchestrate = "on"|"off") — but NOTHING
// in the run pipeline ever read that stamp. Every session behaved
// identically regardless of variant, so the entire A/B framework was
// measuring pure noise dressed up as an experiment. This test proves the
// fix causes a REAL difference in what gets sent to the model, not just
// that the code reads plausibly.
//
// Runs against a THROWAWAY data dir (paths.js stubbed) — never touches the
// live ~/.llm-terminal. No real claude process spawned — _buildVariantPromptAdd
// is a pure lookup+string-build function, safe/cheap to call directly.
//
// Run: node web/scripts/test-orchestrate-variant-wiring.js
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmt-variantwiring-test-"));
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

const { saveSessions } = require("../src/store");
const { _buildVariantPromptAdd } = require("../src/providers/claude");

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS" : "  FAIL") + " — " + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
}

console.log("== case 1: orchestrate:off session gets the suppression instruction ==");
saveSessions([{ id: "variant-off-0001", project: "llmterminal", variants: { orchestrate: "off" } }]);
const offAdd = _buildVariantPromptAdd("variant-off-0001");
check("non-empty prompt addition for off variant", offAdd.length > 0);
check("mentions suppressing decompose/dispatch behavior", /do not use the orchestrate skill/i.test(offAdd));
check("mentions orchestrate:off explicitly (traceable in transcripts)", /orchestrate:off/i.test(offAdd));

console.log("\n== case 2: orchestrate:on session gets NO suppression (baseline/unsuppressed) ==");
saveSessions([{ id: "variant-off-0001", project: "llmterminal", variants: { orchestrate: "off" } },
              { id: "variant-on-0002", project: "llmterminal", variants: { orchestrate: "on" } }]);
const onAdd = _buildVariantPromptAdd("variant-on-0002");
check("empty prompt addition for on variant (no suppression)", onAdd === "");

console.log("\n== case 3: pre-experiment session (no variants field) gets NO suppression ==");
saveSessions([{ id: "variant-off-0001", project: "llmterminal", variants: { orchestrate: "off" } },
              { id: "variant-on-0002", project: "llmterminal", variants: { orchestrate: "on" } },
              { id: "variant-none-0003", project: "llmterminal" }]);
const noneAdd = _buildVariantPromptAdd("variant-none-0003");
check("empty prompt addition when session has no variants stamp at all", noneAdd === "");

console.log("\n== case 4: unknown session id (defensive — must not throw) ==");
let threw = false;
let unknownAdd = "";
try { unknownAdd = _buildVariantPromptAdd("does-not-exist-0004"); } catch { threw = true; }
check("does not throw on unknown session id", !threw);
check("returns empty string for unknown session", unknownAdd === "");

console.log("\n== case 5: orchestrate_style:minimal gets the direct-execution bias ==");
saveSessions([
  { id: "variant-off-0001", project: "llmterminal", variants: { orchestrate: "off" } },
  { id: "variant-on-0002", project: "llmterminal", variants: { orchestrate: "on" } },
  { id: "variant-none-0003", project: "llmterminal" },
  { id: "variant-style-minimal-0005", project: "llmterminal", variants: { orchestrate: "on", orchestrate_style: "minimal" } },
]);
const minimalAdd = _buildVariantPromptAdd("variant-style-minimal-0005");
check("non-empty prompt addition for orchestrate_style:minimal", minimalAdd.length > 0);
check("mentions biasing toward direct execution", /bias hard toward direct execution/i.test(minimalAdd));
check("names orchestrate_style:minimal explicitly (traceable in transcripts)", /orchestrate_style:minimal/i.test(minimalAdd));

console.log("\n== case 6: orchestrate_style:full gets NO extra bias (baseline arm) ==");
saveSessions([
  { id: "variant-off-0001", project: "llmterminal", variants: { orchestrate: "off" } },
  { id: "variant-on-0002", project: "llmterminal", variants: { orchestrate: "on" } },
  { id: "variant-none-0003", project: "llmterminal" },
  { id: "variant-style-minimal-0005", project: "llmterminal", variants: { orchestrate: "on", orchestrate_style: "minimal" } },
  { id: "variant-style-full-0006", project: "llmterminal", variants: { orchestrate: "on", orchestrate_style: "full" } },
]);
const fullAdd = _buildVariantPromptAdd("variant-style-full-0006");
check("empty prompt addition for orchestrate_style:full (baseline, no nudge)", fullAdd === "");

console.log("\n== case 7: orchestrate:off WINS over orchestrate_style:minimal (no double-instruction) ==");
saveSessions([
  { id: "variant-off-0001", project: "llmterminal", variants: { orchestrate: "off" } },
  { id: "variant-on-0002", project: "llmterminal", variants: { orchestrate: "on" } },
  { id: "variant-none-0003", project: "llmterminal" },
  { id: "variant-style-minimal-0005", project: "llmterminal", variants: { orchestrate: "on", orchestrate_style: "minimal" } },
  { id: "variant-style-full-0006", project: "llmterminal", variants: { orchestrate: "on", orchestrate_style: "full" } },
  { id: "variant-off-and-minimal-0007", project: "llmterminal", variants: { orchestrate: "off", orchestrate_style: "minimal" } },
]);
const offWinsAdd = _buildVariantPromptAdd("variant-off-and-minimal-0007");
check("orchestrate:off text wins, not orchestrate_style:minimal text", /orchestrate:off/i.test(offWinsAdd) && !/orchestrate_style:minimal/i.test(offWinsAdd));

console.log(failures === 0 ? "\nALL CHECKS PASSED (" + tmp + ")" : "\n" + failures + " CHECK(S) FAILED (" + tmp + ")");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

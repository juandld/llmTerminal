#!/usr/bin/env node
// One-shot backfill CLI for the loose-ends bridge (src/loose-ends.js).
// Dry-run by default: classifies closed sessions in the window and prints the
// report WITHOUT filing queue items or writing the audit marker — the
// calibration mode. Pass --live to file for real (dedup against the queue's
// origin_session links prevents re-filing the 2026-07-30 manual-sweep items).
//
//   node scripts/sweep-loose-ends.js                        # dry-run, 28 days
//   node scripts/sweep-loose-ends.js --live --max-files 5
//   node scripts/sweep-loose-ends.js --session a6d24892     # one session
const { sweepLooseEnds } = require("../src/loose-ends");

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
  const opts = {
    dryRun: !process.argv.includes("--live"),
    windowDays: Number(argVal("--window-days", 28)),
    maxHaiku: Number(argVal("--max-haiku", 50)),
    maxFiles: Number(argVal("--max-files", 5)),
    sessionId: argVal("--session", null) || undefined,
    // Calibration: classify even sessions that already have a queue item
    // (needed to test against the 2026-07-30 manually-filed reference cases).
    // Only honored together with dry-run — never file duplicates.
    ignoreFiled: process.argv.includes("--ignore-filed") && !process.argv.includes("--live"),
  };
  console.error("[sweep-loose-ends] opts:", JSON.stringify(opts));
  const report = await sweepLooseEnds(opts);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

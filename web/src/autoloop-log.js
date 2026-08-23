// Autoloop observability log (2026-08-23). Every iteration of the
// harness-plan autoloop that ships or verifies a change appends one row
// here — the durable record of WHAT was attempted, HOW it was verified
// (curl vs actual Playwright browser pass vs unit test vs read-only), and
// WHAT remains unknown (open questions / implications not yet resolved).
//
// Why this exists: prior iterations shipped UI code (voice-attach chip,
// wake-prompt chip) and claimed "verified" from reading the diff, without
// ever driving a real browser. Reading code is not verification — David
// asked explicitly for complete observability + the right browser
// methodology so iteration can answer "what to do better," not just "what
// got merged." This file is the log that makes that answerable after the
// fact instead of re-litigated from memory each time.
//
// Verification methodology (enforced by convention, not code — see
// HARNESS_PLAN.md "Observability & Browser-Verification Methodology"):
//   - UI-touching slot (web/public/*.js, styles.css) → NOT verified until a
//     Playwright pass has navigated the live page, read console messages
//     for new errors, and captured a screenshot as evidence.
//   - Backend-only slot → curl against the live endpoint, response body
//     quoted in verifyEvidence.
//   - Investigation/research → read-only confirmation, cite exact files read.
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const AUTOLOOP_LOG = path.join(DATA_DIR, "autoloop-log.jsonl");

function recordIteration(entry) {
  const row = {
    ts: Date.now(),
    slot: entry.slot ?? null,
    action: String(entry.action || "").slice(0, 500),
    verifyMethod: entry.verifyMethod || "none", // "browser" | "curl" | "unit-test" | "read-only" | "none"
    verifyEvidence: String(entry.verifyEvidence || "").slice(0, 2000),
    openQuestions: Array.isArray(entry.openQuestions) ? entry.openQuestions.slice(0, 10) : [],
    implications: Array.isArray(entry.implications) ? entry.implications.slice(0, 10) : [],
    nextRecommended: entry.nextRecommended || null,
    // Explicit closure list (2026-08-23 fix) — substrings of prior
    // openQuestions text that THIS entry deliberately resolves. Added after
    // discovering the fuzzy action/implications-text matcher below almost
    // never actually fired: iterations kept phrasing closures in prose
    // ("closed the X question") that didn't share a long-enough substring
    // with the original question text, so unresolvedQuestions() kept
    // reporting stale/already-closed items every single check this session.
    // Explicit >  inferred, same principle as the enforced-steps section.
    resolves: Array.isArray(entry.resolves) ? entry.resolves.slice(0, 10) : [],
  };
  try {
    fs.appendFileSync(AUTOLOOP_LOG, JSON.stringify(row) + "\n");
  } catch (e) {
    console.error("[autoloop-log] append failed:", e.message);
  }
  return row;
}

function readRecent(n) {
  const limit = n || 30;
  let rows = [];
  try {
    const raw = fs.readFileSync(AUTOLOOP_LOG, "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.error("[autoloop-log] read failed:", e.message);
  }
  return rows.slice(-limit).reverse(); // newest first
}

// Open questions across recent history that haven't been explicitly closed.
// Primary mechanism: a later entry's `resolves` array explicitly names the
// question it's closing (deliberate, reliable). Fallback: a loose
// action/implications-text substring match, kept for entries recorded
// before `resolves` existed — genuinely crude, rarely fires, don't rely on it.
function unresolvedQuestions() {
  const rows = readRecent(200).slice().reverse(); // oldest first for this pass
  const questions = []; // {text, fromTs, resolved}
  for (const r of rows) {
    for (const q of r.openQuestions || []) {
      questions.push({ text: q, fromTs: r.ts, resolved: false });
    }
    const resolves = (r.resolves || []).map(s => String(s).toLowerCase());
    const haystack = (String(r.action || "") + " " + (r.implications || []).join(" ")).toLowerCase();
    for (const prev of questions) {
      if (prev.resolved || prev.fromTs === r.ts) continue;
      const prevLower = prev.text.toLowerCase();
      // Explicit: does ANY resolves-entry appear in the question, or the
      // question's start appear in a resolves-entry? Either direction
      // counts — callers may quote the question verbatim OR paraphrase it.
      const explicitlyResolved = resolves.some(r2 => r2.length > 6 && (prevLower.includes(r2) || r2.includes(prevLower.slice(0, 30))));
      if (explicitlyResolved) { prev.resolved = true; continue; }
      // Fallback fuzzy match (legacy, weak — see comment above).
      const needle = prevLower.slice(0, 40);
      if (needle.length > 8 && haystack.includes(needle)) prev.resolved = true;
    }
  }
  return questions.filter(q => !q.resolved).reverse(); // newest-first
}

module.exports = { recordIteration, readRecent, unresolvedQuestions };

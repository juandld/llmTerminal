// HARNESS_PLAN.md parser — read-only structural extraction for the live
// plan-progress board (slot #9). Pure: takes a path, returns structured
// data; no side effects beyond one fs.readFileSync.
//
// Extracts:
//   - Numbered slots via /^### (\d+)\. (.+)$/m
//   - Progress log entries via /^- \*\*(\d{4}-\d{2}-\d{2})\*\* — (.+)$/gm
//   - Per-slot state inferred from the progress-log wording:
//       shipped     — "#N shipped" (any case) appears in a log entry
//       decided     — "#N decided" appears in a log entry (research/decision
//                     slots that resolve without shipping code)
//       in-progress — "STARTING HERE" marker on the slot heading OR a log
//                     entry mentions "starting on **#N" / "#N ... in progress"
//       deferred    — "#N deferred" or "deferred until #N" in a log entry,
//                     OR the slot body opens with "Deferred until"
//       todo        — default
//
// Returned shape:
//   { slots: [{num, title, state, blurb}], progressLog: [{date, text}], updated_at }

const fs = require("fs");

const SLOT_RE = /^### (\d+)\. (.+)$/gm;
// Multi-line log entries: match the "- **DATE** — first line" header, then
// consume all continuation lines (indented by whitespace or blank) up to the
// next entry / next heading. Captures ONLY the log body (no leading dash /
// bold date).
const LOG_HEADER_RE = /^- \*\*(\d{4}-\d{2}-\d{2})\*\* — (.*)$/;

// Extract the contents of every **bold** span in a string (no `*` between
// the delimiters, so spans don't bleed into each other).
function _boldSpans(text) {
  const spans = [];
  const re = /\*\*([^*\n]+)\*\*/g;
  let m;
  while ((m = re.exec(text)) !== null) spans.push(m[1]);
  return spans;
}

// Does a bold span claim `numTok` (e.g. "#6") has reached `keyword` (e.g.
// "shipped")? Requires numTok to be the ONLY slot number mentioned in that
// span — a span like "**Slot #6 ... found a gap in slot #3, marked
// "shipped"**" mentions #3 too, so it must NOT count as #6 being shipped
// (real false positive caught 2026-08-23: a #6 entry describing a bug it
// found in #3's "shipped" status was itself misread as "#6 shipped").
function _spanClaims(spans, numTok, keyword) {
  const kwRe = new RegExp("\\b" + keyword + "\\b", "i");
  for (const span of spans) {
    const nums = span.match(/#\d+/g) || [];
    const hasThisNum = nums.includes(numTok);
    const hasOtherNum = nums.some(n => n !== numTok);
    if (hasThisNum && !hasOtherNum && kwRe.test(span)) return true;
  }
  return false;
}

function inferState(num, title, blurb, progressLog) {
  // Progress log wins over heading markers.
  const numTok = "#" + num;
  // "**#N shipped**" / "**Slot #N (...) shipped**" — the strongest signal.
  // Scoped to a bold span that mentions ONLY this slot's number (see
  // _spanClaims) so a span discussing multiple slots at once — e.g. "found
  // a gap in #3's shipped status while building #6" — can't false-positive
  // either slot. Tolerates an optional "Slot " prefix and a parenthetical
  // between the number and "shipped" (both real phrasings in practice).
  for (const entry of progressLog) {
    if (_spanClaims(_boldSpans(entry.text), numTok, "shipped")) return "shipped";
  }
  // "DECIDED" — for research/decision slots that resolve without shipping
  // code (e.g. "build vs don't build" calls). Same span-exclusivity rule.
  for (const entry of progressLog) {
    if (_spanClaims(_boldSpans(entry.text), numTok, "decided")) return "decided";
  }
  for (const entry of progressLog) {
    const t = entry.text;
    if (new RegExp(numTok + "\\s+deferred", "i").test(t)) return "deferred";
    if (new RegExp("deferred until " + numTok, "i").test(t)) return "deferred";
    // "#8) — that stays deferred" and similar — #N followed by any chars then
    // "deferred" within ~80 chars counts as a manual defer signal.
    const nearRe = new RegExp(numTok + "\\)?[^#]{0,80}?\\bdeferred\\b", "i");
    if (nearRe.test(t)) return "deferred";
  }
  // In-progress: heading has STARTING HERE marker OR log says "starting on #N"
  if (/←\s*STARTING HERE/i.test(title)) return "in-progress";
  for (const entry of progressLog) {
    const t = entry.text;
    if (new RegExp("starting on \\*\\*" + numTok, "i").test(t)) return "in-progress";
  }
  // Slot body opens with "Deferred until ..." — treat as deferred
  if (blurb && /^\s*Deferred until\b/i.test(blurb)) return "deferred";
  return "todo";
}

function extractBlurb(md, startIdx, endIdx) {
  // Grab the first non-empty paragraph after the heading, up to ~240 chars.
  // Skip the blank line right after the heading; stop at the next blank line.
  const chunk = md.slice(startIdx, endIdx);
  const lines = chunk.split("\n").slice(1); // drop the heading line itself
  let started = false;
  const buf = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (started) break; else continue; }
    started = true;
    buf.push(line);
    if (buf.join(" ").length > 240) break;
  }
  const joined = buf.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 260 ? joined.slice(0, 260).trimEnd() + "…" : joined;
}

function parseHarnessPlan(mdPath) {
  const stat = fs.statSync(mdPath);
  const md = fs.readFileSync(mdPath, "utf8");

  // Progress log — collect first so state inference can consult it.
  // The log section is everything after the "## Progress log" heading.
  const progressLog = [];
  const logSectionStart = md.search(/^##\s+Progress log\s*$/m);
  const logSection = logSectionStart >= 0 ? md.slice(logSectionStart) : md;
  const lines = logSection.split("\n");
  let current = null;
  for (const line of lines) {
    const hdr = LOG_HEADER_RE.exec(line);
    if (hdr) {
      if (current) progressLog.push(current);
      current = { date: hdr[1], text: hdr[2].trim() };
    } else if (current) {
      // Continuation lines: any indented line or blank line right after.
      // Stop at a new top-level heading or an unindented non-blank non-log line.
      if (/^\s+\S/.test(line)) {
        current.text += " " + line.trim();
      } else if (/^\s*$/.test(line)) {
        // blank inside an entry — allow, keeps entries continuous through
        // paragraph breaks in the same bullet
        continue;
      } else if (/^#{1,6}\s/.test(line)) {
        progressLog.push(current);
        current = null;
        break;
      } else {
        // unindented non-blank, non-log-header line — end of the entry
        progressLog.push(current);
        current = null;
      }
    }
  }
  if (current) progressLog.push(current);
  // Normalize whitespace (collapse multi-space runs).
  for (const e of progressLog) e.text = e.text.replace(/\s+/g, " ").trim();
  // Newest first — file uses append-at-bottom convention, so reverse.
  progressLog.reverse();

  // Slots.
  SLOT_RE.lastIndex = 0;
  const rawSlots = [];
  while ((m = SLOT_RE.exec(md)) !== null) {
    rawSlots.push({ num: Number(m[1]), title: m[2].trim(), matchIdx: m.index });
  }
  const slots = rawSlots.map((s, i) => {
    const endIdx = i + 1 < rawSlots.length ? rawSlots[i + 1].matchIdx : md.length;
    const blurb = extractBlurb(md, s.matchIdx, endIdx);
    const state = inferState(s.num, s.title, blurb, progressLog);
    // Strip the STARTING HERE marker from the display title.
    const cleanTitle = s.title.replace(/\s*←\s*STARTING HERE\s*$/i, "").trim();
    return { num: s.num, title: cleanTitle, state, blurb };
  });
  slots.sort((a, b) => a.num - b.num);

  return {
    slots,
    progressLog,
    updated_at: stat.mtimeMs,
  };
}

module.exports = { parseHarnessPlan };

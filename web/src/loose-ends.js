// Loose-ends bridge (session→queue, supervisor-pattern observer #5).
// After a session closes (manualDone set), audit whether the chat's OPENING
// GOAL was actually accomplished — not merely emailed about, discussed, or
// drifted away from (the 2026-07-30 Colin miss: "email sent" closed a chat
// whose goal still needed a video). Unmet goals become orchestrator queue
// items with an origin_session back-link and a "done-criteria:" timeline
// stamp, so the queue supervisor's doer/verifier loop keeps the work alive
// across session death and token walls (_fetch_done_criteria reads the stamp).
//
// Design source: pilot chat efb19b4b (manual sweep of 8 chats, 2026-07-30) +
// standing queue item 0c2da8b8a5c7459e. Reference calibration cases the
// classifier must reproduce: sessions a6d24892, 95b32565, dbb9d616, 08704a72.
//
// Runs two ways, same function:
//   - server.js cadence (5 min, next to sweepStalledSessions) — catches each
//     newly closed session; the audit marker (keyed sid+manualDone ts) makes
//     steady-state ticks near-free.
//   - scripts/sweep-loose-ends.js — one-shot backfill over the last N weeks,
//     dry-run by default for calibration.
const fs = require("fs");
const path = require("path");
const { DATA_DIR, SESSIONS_FILE, MESSAGES_DIR } = require("./paths");
const { runCheapClaude } = require("./cheap-model");

const ORCH_BASE = "http://localhost:8000/api/orchestrator";
const AUDIT_FILE = path.join(DATA_DIR, "loose-ends-audit.json");
const MIN_MESSAGES = 4;
// Pre-close ⚠ warnings from the contract-check gates (supervisors.js). The
// manual sweep found their presence in the tail = near-100% precision for a
// loose end (95b32565 had both). Haiku still runs — for the goal/title — but
// the verdict is forced to "loose".
const WARNING_SOURCES = new Set(["contract_check_unverified_claim", "contract_check_uncommitted"]);
const HAIKU_TIMEOUT_MS = 150000; // throttle can defer 60s + 45s proc budget

function _loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function loadAudit() { return _loadJson(AUDIT_FILE, { sessions: {} }); }
function saveAudit(a) { fs.writeFileSync(AUDIT_FILE, JSON.stringify(a, null, 2)); }

function _msgText(m, max) {
  const r = (m.role || "").toUpperCase();
  let t = m.text || m.summary || "";
  if (r === "TOOL_ACTIVITY") t = `(${m.tool_name || "tool"}) ${String(t)}`.slice(0, 160);
  else t = String(t).slice(0, max);
  return t ? `${r}: ${t}` : null;
}

function _buildPrompt(session, msgs) {
  const firstUser = msgs.find(m => m.role === "user");
  const lastUser = [...msgs].reverse().find(m => m.role === "user");
  const tail = msgs.slice(-15).map(m => _msgText(m, 500)).filter(Boolean).join("\n\n");
  const opening = String((firstUser && firstUser.text) || "").slice(0, 1500);
  let latest = "";
  if (lastUser && firstUser && lastUser.ts !== firstUser.ts) {
    latest = "\n\nLATEST USER MESSAGE (if the chat drifted, judge the ORIGINAL goal — a drifted chat whose original goal was abandoned is NOT met):\n" + String(lastUser.text || "").slice(0, 900);
  }
  return `You are auditing a CLOSED agent chat for loose ends. Decide whether the user's opening goal was ACTUALLY accomplished by the end of the chat — verifiably done, not merely discussed, partially done, emailed about, or handed off with work remaining.

Output JSON ONLY (no prose, no fences):
{"goal": "<the concrete deliverable(s) the user wanted, <=40 words>",
 "met": true|false,
 "remaining": "<if not met: the concrete open sub-actions, <=60 words; else null>",
 "title": "<if not met: short imperative task title 5-12 words; else null>"}

Rules:
- met=true ONLY if the tail shows the deliverable verifiably exists (sent + confirmed, committed, deployed, question fully answered in-chat) or the user explicitly accepted the close.
- Sending an email ABOUT work does not complete the work.
- Chat drifted to another topic and the opening goal was dropped → met=false.
- Purely conversational/lookup chats where the answer was delivered in-chat → met=true.
- When uncertain, met=false (a false loose-end costs a triage tap; a false close loses the work).

CHAT TITLE: ${session.title || "(untitled)"}
OPENING USER MESSAGE (the goal):
${opening}${latest}

TAIL (last messages before close, NEWEST AT BOTTOM):
${tail}`;
}

function _classify(session, msgs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), HAIKU_TIMEOUT_MS);
    try {
      runCheapClaude(_buildPrompt(session, msgs), "loose-ends", async (parsed) => {
        if (parsed && (parsed.met === true || parsed.met === false)) finish(parsed);
        else finish(null);
      }, session.project);
    } catch (e) {
      console.error("[loose-ends] classify spawn failed:", e.message);
      finish(null);
    }
  });
}

// One fetch of the queue per sweep: sessions that already have an item filed
// against them (origin_session match, or their id quoted in a description —
// the 2026-07-30 manual items) must not be re-filed.
async function _queueOriginIndex() {
  const r = await fetch(ORCH_BASE + "/queue/items?limit=500");
  if (!r.ok) throw new Error("queue/items " + r.status);
  const items = (await r.json()).items || [];
  const origins = new Set(items.map(i => i.origin_session).filter(Boolean));
  const blob = items.map(i => (i.title || "") + " " + (i.description || "")).join("\n");
  return { origins, blob };
}

async function _fileLooseEnd(session, verdict, reason) {
  const closedAt = session.manualDone ? new Date(session.manualDone).toISOString().slice(0, 10) : "?";
  const title = ("Loose end: " + (verdict.title || session.title || session.id.slice(0, 8))).slice(0, 140);
  const description = [
    "Loose-ends bridge: this chat closed without its opening goal being met.",
    "",
    "Goal: " + (verdict.goal || "(unextracted)"),
    "Remaining: " + (verdict.remaining || "(see origin chat tail)"),
    "Flagged because: " + reason,
    "",
    `Origin session: ${session.id} ("${session.title || "untitled"}", project ${session.project}, closed ${closedAt})`,
    "",
    "Filed by sweepLooseEnds (llmTerminal session→queue bridge). Intended priority tier: standing (filed as normal until the tier exists).",
  ].join("\n");
  const r = await fetch(ORCH_BASE + "/queue/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description, priority: "normal", project_id: session.project, origin_session: session.id }),
  });
  if (!r.ok) throw new Error("queue/create " + r.status);
  const taskId = ((await r.json()).item || {}).task_id;
  if (taskId) {
    // done-criteria stamp — same mechanism as queue_supervisor's loop items;
    // the doer/verifier resolve it via _fetch_done_criteria.
    const dc = "done-criteria: " + String(verdict.remaining || verdict.goal || "origin-session goal verifiably met").slice(0, 380);
    const r2 = await fetch(ORCH_BASE + `/queue/items/${taskId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: dc }),
    });
    if (!r2.ok) console.warn("[loose-ends] done-criteria stamp failed:", r2.status);
  }
  return taskId;
}

// opts: windowDays (28), dryRun (false), maxHaiku (4), maxFiles (2),
//       sessionId (limit to one session), verbose (false)
async function sweepLooseEnds(opts = {}) {
  const windowDays = opts.windowDays || 28;
  const dryRun = !!opts.dryRun;
  const maxHaiku = opts.maxHaiku != null ? opts.maxHaiku : 4;
  const maxFiles = opts.maxFiles != null ? opts.maxFiles : 2;
  const now = Date.now();
  const audit = loadAudit();
  const report = { scanned: 0, judged: 0, filed: [], wouldFile: [], met: [], deferred: 0, errors: 0 };

  let sessions = _loadJson(SESSIONS_FILE, []);
  if (opts.sessionId) sessions = sessions.filter(s => s.id === opts.sessionId || s.id.startsWith(opts.sessionId));

  let originIdx = null;
  try { originIdx = await _queueOriginIndex(); }
  catch (e) {
    // Without the dedup index, filing risks duplicates — judge nothing this tick.
    console.error("[loose-ends] queue unreachable, skipping sweep:", e.message);
    return report;
  }

  let haikuUsed = 0;
  for (const s of sessions) {
    if (!s.manualDone) continue;
    if (s.manualDone < now - windowDays * 86400000) continue;
    if ((s.messageCount || 0) < MIN_MESSAGES) continue;
    const prior = audit.sessions[s.id];
    if (prior && prior.manualDone === s.manualDone) continue; // audited this close already
    report.scanned++;

    if (!opts.ignoreFiled && (originIdx.origins.has(s.id) || originIdx.blob.includes(s.id.slice(0, 8)))) {
      // Already represented in the queue (manual sweep or an earlier tick).
      if (!dryRun) { audit.sessions[s.id] = { manualDone: s.manualDone, ts: now, verdict: "already-filed" }; }
      continue;
    }
    if (haikuUsed >= maxHaiku) { report.deferred++; continue; } // next tick picks it up

    const msgs = _loadJson(path.join(MESSAGES_DIR, s.id + ".json"), []);
    if (msgs.length < MIN_MESSAGES) continue;
    const warned = msgs.slice(-20).some(m => WARNING_SOURCES.has(m.source));

    haikuUsed++;
    report.judged++;
    const verdict = await _classify(s, msgs);
    if (!verdict) { report.errors++; continue; } // governor drop/timeout — retry next tick

    const loose = warned || verdict.met === false;
    const reason = warned ? "⚠ contract-check warning in the tail before close (near-certain loose end)" : "goal-audit: " + (verdict.remaining || "goal not met at close");
    const row = { sid: s.id.slice(0, 8), title: s.title, goal: verdict.goal, remaining: verdict.remaining, warned };

    if (!loose) {
      report.met.push(row);
      if (!dryRun) audit.sessions[s.id] = { manualDone: s.manualDone, ts: now, verdict: "met" };
      continue;
    }
    if (dryRun) { report.wouldFile.push(row); continue; }
    if (report.filed.length >= maxFiles) { report.deferred++; continue; } // stays unaudited → next tick
    try {
      const taskId = await _fileLooseEnd(s, verdict, reason);
      row.task_id = taskId;
      report.filed.push(row);
      audit.sessions[s.id] = { manualDone: s.manualDone, ts: now, verdict: "loose", task_id: taskId };
      console.log("[loose-ends]", s.id.slice(0, 8), "→ FILED", taskId, "—", (verdict.title || "").slice(0, 60));
    } catch (e) {
      report.errors++;
      console.error("[loose-ends] filing failed for", s.id.slice(0, 8), ":", e.message);
    }
  }

  if (!dryRun) saveAudit(audit);
  if (report.judged || report.filed.length) {
    console.log(`[loose-ends] sweep: scanned=${report.scanned} judged=${report.judged} filed=${report.filed.length} met=${report.met.length} deferred=${report.deferred} errors=${report.errors}${dryRun ? " (dry-run)" : ""}`);
  }
  return report;
}

module.exports = { sweepLooseEnds, loadAudit, AUDIT_FILE };

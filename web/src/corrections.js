// Correction ledger — the H9 "correction reflex" (harness_architecture v2).
// A correction is a user turn that redirects, negates, stops or repeats an
// instruction the agent already had. spawnCorrectionExtractor (supervisors.js)
// classifies each one and writes it here; buildPromptAdd feeds a project's
// recent corrections — plus the UI cards currently visible in the chat — back
// into every turn's system prompt, so the next agent inherits the rule instead
// of making David re-earn it.
const { db, loadMessages } = require("./store");

const CLASSES = [
  "wrong-referent", "wrong-project", "guessed-fact", "ignored-context",
  "unnecessary-ask", "wrong-intent", "didnt-stop", "harness-bug", "repeat", "other",
];
const STATUSES = ["open", "guarded", "dismissed"];
const WINDOW_DAYS = 14;
const CARD_ROLES = new Set(["email_reply", "email_draft", "email_sent", "question"]);

function clip(s, n) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function insertCorrection(row) {
  if (!db) return null;
  const r = db.prepare(`INSERT OR IGNORE INTO corrections
    (session_id, project, ts, user_ts, class, severity, user_said, agent_did, user_meant,
     missing_context, guard_candidate, recovered, interrupted, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`).run(
    row.session_id, row.project || null, row.ts, row.user_ts, row.class, row.severity,
    row.user_said, row.agent_did, row.user_meant, row.missing_context, row.guard_candidate,
    row.recovered ? 1 : 0, row.interrupted ? 1 : 0,
  );
  return r && r.changes ? Number(r.lastInsertRowid) : null;
}

function hasCorrectionFor(sessionId, userTs) {
  if (!db) return false;
  const r = db.prepare("SELECT 1 AS x FROM corrections WHERE session_id = ? AND user_ts = ? LIMIT 1").get(sessionId, userTs);
  return !!r;
}

function listCorrections(opts = {}) {
  if (!db) return [];
  const where = [];
  const args = [];
  if (opts.project) { where.push("project = ?"); args.push(opts.project); }
  if (opts.sessionId) { where.push("session_id = ?"); args.push(opts.sessionId); }
  if (opts.cls) { where.push("class = ?"); args.push(opts.cls); }
  if (opts.status) { where.push("status = ?"); args.push(opts.status); }
  if (opts.days) { where.push("ts > ?"); args.push(Date.now() - opts.days * 86400000); }
  const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 1000));
  const sql = "SELECT * FROM corrections" + (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY ts DESC, id DESC LIMIT " + limit;
  return db.prepare(sql).all(...args).map(r => ({ ...r, recovered: !!r.recovered, interrupted: !!r.interrupted }));
}

function summarizeByClass(opts = {}) {
  const rows = listCorrections({ ...opts, limit: 1000 });
  const by = {};
  for (const r of rows) {
    const b = by[r.class] || (by[r.class] = { class: r.class, count: 0, high: 0, latest_ts: 0, projects: {} });
    b.count++;
    if (r.severity === "high") b.high++;
    if (r.ts > b.latest_ts) b.latest_ts = r.ts;
    if (r.project) b.projects[r.project] = (b.projects[r.project] || 0) + 1;
  }
  return Object.values(by).sort((a, b) => b.count - a.count);
}

function setStatus(id, status, artifact) {
  if (!db) return null;
  if (!STATUSES.includes(status)) throw new Error("bad status");
  db.prepare("UPDATE corrections SET status = ?, artifact = COALESCE(?, artifact) WHERE id = ?").run(status, artifact || null, id);
  return db.prepare("SELECT * FROM corrections WHERE id = ?").get(id) || null;
}

// ── Ambient: recent corrections for this project, as standing rules ──
function buildCorrectionsBlock(project) {
  if (!db || !project) return "";
  const since = Date.now() - WINDOW_DAYS * 86400000;
  const rows = db.prepare(
    "SELECT class, severity, user_meant, ts FROM corrections WHERE project = ? AND ts > ? AND status != 'dismissed' " +
    "AND user_meant IS NOT NULL ORDER BY ts DESC LIMIT 80"
  ).all(project, since);
  if (!rows.length) return "";
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.class) || { count: 0, high: 0, meant: [] };
    g.count++;
    if (r.severity === "high") g.high++;
    if (g.meant.length < 2 && !g.meant.some(m => m.toLowerCase() === r.user_meant.toLowerCase())) g.meant.push(r.user_meant);
    groups.set(r.class, g);
  }
  const ordered = [...groups.entries()].sort((a, b) => (b[1].high - a[1].high) || (b[1].count - a[1].count));
  const lines = [];
  let budget = 1200;
  for (const [cls, g] of ordered) {
    if (lines.length >= 6) break;
    const line = `- ${cls} (×${g.count}${g.high ? ", " + g.high + " high" : ""}): ${g.meant.join(" · ")}`;
    if (budget - line.length < 0) break;
    budget -= line.length;
    lines.push(line);
  }
  if (!lines.length) return "";
  return `# recentCorrections (${project}, last ${WINDOW_DAYS}d — moments David had to redirect an agent. Each is a standing rule; do not repeat the mistake.)\n` + lines.join("\n");
}

// ── Ambient: the llmTerminal cards rendered in THIS chat right now ──
// Resolves "this card" / "the one I see here" and states who owns the card
// chrome, so UI feedback gets routed to llmTerminal instead of grepping the
// session's project for a dashboard that isn't the thing David is looking at.
function buildVisibleCardsBlock(sessionId, project) {
  if (!sessionId) return "";
  let msgs;
  try { msgs = loadMessages(sessionId); } catch { return ""; }
  if (!msgs || !msgs.length) return "";
  const recent = msgs.slice(-40);
  const recentSet = new Set(recent);
  const sticky = msgs.filter(m => CARD_ROLES.has(m.role) && !recentSet.has(m));
  const cards = [...sticky, ...recent].filter(m => CARD_ROLES.has(m.role));
  if (!cards.length) return "";
  // Collapse redrafts: one line per (to, subject) family, SENT wins, and an
  // email_sent record folds into its draft — otherwise a chat with four
  // iterations of one reply lists four identical cards and pushes the
  // inbound email_reply (the referent David usually means) off the list.
  const drafts = new Map();
  const others = [];
  for (const m of cards) {
    if (m.role === "email_draft" || m.role === "email_sent") {
      const key = String(m.to || "").toLowerCase() + "|" +
        String(m.subject || "").toLowerCase().replace(/^(re|fwd?):\s*/i, "");
      const d = drafts.get(key) || { to: m.to, subject: m.subject, sent: false, ts: 0 };
      d.sent = d.sent || !!m.sent || m.role === "email_sent";
      if (m.to) d.to = m.to;
      if (m.subject) d.subject = m.subject;
      d.ts = Math.max(d.ts, m.ts || 0);
      drafts.set(key, d);
    } else {
      others.push(m);
    }
  }
  const items = [];
  for (const m of others) {
    const subj = m.subject ? ` "${clip(m.subject, 70)}"` : "";
    if (m.role === "email_reply") {
      items.push({ ts: m.ts || 0, line: `- email_reply card — inbound reply from ${m.fromEmail || "?"}${subj}${m.messageId ? " (gmail message " + m.messageId + ")" : ""}` });
    } else if (m.role === "question") {
      items.push({ ts: m.ts || 0, line: `- question card — ${clip(m.text || m.summary || "", 90) || "(pending llmt_ask)"}` });
    }
  }
  for (const d of drafts.values()) {
    const subj = d.subject ? ` "${clip(d.subject, 70)}"` : "";
    items.push({ ts: d.ts, line: `- email_draft card — to ${d.to || "?"}${subj} ${d.sent ? "(SENT)" : "(unsent; David sends with one tap)"}` });
  }
  const lines = items.sort((a, b) => a.ts - b.ts).slice(-6).map(x => x.line);
  if (!lines.length) return "";
  return `# visibleCards (llmTerminal UI cards rendered in THIS chat. When David says "this card" / "the one I see here" / "that button", he means one of these. The card chrome — buttons, layout, what it displays — is llmTerminal's code: feedback about the CARD belongs to the llmTerminal project, not ${project || "this project"}; the email/thread CONTENT belongs to this chat.)\n` + lines.join("\n");
}

function buildPromptAdd(sessionId, project) {
  try {
    const a = buildCorrectionsBlock(project);
    const b = buildVisibleCardsBlock(sessionId, project);
    return [a, b].filter(Boolean).map(x => "\n\n" + x).join("");
  } catch (e) {
    console.warn("[corrections] prompt block failed (non-fatal):", e.message);
    return "";
  }
}

module.exports = {
  CLASSES, STATUSES, WINDOW_DAYS, clip,
  insertCorrection, hasCorrectionFor, listCorrections, summarizeByClass, setStatus,
  buildCorrectionsBlock, buildVisibleCardsBlock, buildPromptAdd,
};

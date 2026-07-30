// Persistence layer for llmTerminal: SQLite message+decision store and the
// file-based session store. Extracted from server.js (refactor 2026-06-10).
// Owns the `db` handle and exports it so the remaining decisions queries in
// server.js keep working until they are migrated here too.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { SESSIONS_FILE, MESSAGES_DIR, CLAUDE_PROJECTS_DIR, MESSAGES_DB_PATH } = require("./paths");

// ---- SQLite message store ----
let db;
try {
  db = new DatabaseSync(MESSAGES_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts, id);

    -- Decision timeline / tree (David's visualisation framework).
    -- Append-only; resolves via separate UPDATE on status + artifacts.
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      parent_id    INTEGER,
      ts           INTEGER NOT NULL,
      summary      TEXT    NOT NULL,
      chose        TEXT    NOT NULL,
      alternatives TEXT,
      why          TEXT,
      constraints  TEXT,
      cost         TEXT,
      status       TEXT    NOT NULL DEFAULT 'pending',
      artifacts    TEXT,
      mined        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_session_ts ON decisions(session_id, ts, id);
    CREATE INDEX IF NOT EXISTS idx_decisions_parent ON decisions(parent_id);
  `);
  console.log("[sqlite] messages DB opened at", MESSAGES_DB_PATH);
  // One-time migration: import JSON files not yet in DB
  try {
    const files = fs.readdirSync(MESSAGES_DIR).filter(f => f.endsWith(".json"));
    const countStmt = db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?");
    const insertStmt = db.prepare("INSERT INTO messages (session_id, ts, role, data) VALUES (?, ?, ?, ?)");
    let migrated = 0;
    for (const file of files) {
      const sessionId = file.replace(".json", "");
      const existing = countStmt.get(sessionId).c;
      if (existing > 0) continue;
      try {
        const msgs = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, file), "utf8"));
        db.exec("BEGIN");
        try {
          for (const m of msgs) insertStmt.run(sessionId, m.ts || Date.now(), m.role || "", JSON.stringify(m));
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        migrated++;
      } catch (e) { console.error("[migrate]", file, e.message); }
    }
    if (migrated) console.log(`[migrate] imported ${migrated} JSON session file(s) to SQLite`);
  } catch (e) { console.error("[migrate] scan failed:", e.message); }
} catch (e) {
  console.error("[sqlite] init failed, falling back to JSON:", e.message);
  db = null;
}

// ---- Message persistence per session (SQLite-backed, JSON mirror for safety) ----
function loadMessages(sessionId) {
  if (db) {
    try {
      const rows = db.prepare("SELECT data FROM messages WHERE session_id = ? ORDER BY ts ASC, id ASC").all(sessionId);
      return rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
    } catch (e) { console.error("[loadMessages] sqlite failed:", e.message); }
  }
  // Fallback to JSON
  try { return JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, sessionId + ".json"), "utf8")); } catch { return []; }
}
function saveMessage(sessionId, msg) {
  if (!msg.ts) msg.ts = Date.now();
  if (db) {
    try {
      db.prepare("INSERT INTO messages (session_id, ts, role, data) VALUES (?, ?, ?, ?)")
        .run(sessionId, msg.ts, msg.role || "", JSON.stringify(msg));
    } catch (e) { console.error("[saveMessage] sqlite failed:", e.message); }
  }
  // JSON mirror — so backups exist and operators can inspect with cat
  try {
    const p = path.join(MESSAGES_DIR, sessionId + ".json");
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    arr.push(msg);
    fs.writeFileSync(p, JSON.stringify(arr));
  } catch (e) { console.error("[saveMessage] JSON mirror failed:", e.message); }

  // Track last message role on the session so the sidebar can color-code "whose turn"
  try {
    const sessions = loadSessions();
    const s = sessions.find(x => x.id === sessionId);
    if (s && msg.role) {
      s.lastMessageRole = msg.role;
      s.lastActive = Date.now();
      // V1.1: Clear awaitingResponse once the agent produces any output —
      // the session transitions from user_waiting to working/responded.
      if (msg.role !== "user" && s.awaitingResponse) s.awaitingResponse = false;
      // Short activity snippet for sidebar preview
      const text = (msg.text || "").replace(/\s+/g, " ").trim();
      if (msg.role === "assistant" && text) s.lastSnippet = text.slice(0, 80);
      else if (msg.role === "user" && text) s.lastSnippet = "You: " + text.slice(0, 60);
      else if (msg.role === "tool_use") s.lastSnippet = "Running: " + (msg.tool_name || "tool");
      else if (msg.role === "question") s.lastSnippet = "Question waiting";
      else if (msg.role === "permission_denied") s.lastSnippet = "Permission needed";
      // Pending asks: accumulate user messages, clear on substantive assistant reply
      if (msg.role === "user" && text) {
        if (!s.pendingAsks) s.pendingAsks = [];
        s.pendingAsks.push({ text: text.slice(0, 100), ts: msg.ts || Date.now() });
        if (s.pendingAsks.length > 8) s.pendingAsks = s.pendingAsks.slice(-8);
      } else if (msg.role === "assistant" && text.length > 30) {
        s.pendingAsks = [];
      }
      if (msg.role === "email_sent") s.manualDone = Date.now();
      // Note: we used to clear manualDone on any user message, but that
      // wiped the contract-check supervisor's verdict the moment David
      // typed a follow-up. The contract-check fires again after the next
      // assistant reply — if it re-judges "still done," manualDone is
      // re-set; if not, it stays cleared via that path. The UI also
      // offers an explicit unmark button. So we no longer auto-clear here.
      saveSessions(sessions);
    }
  } catch {}
}
// In-place patch of one row identified by (sessionId, ts, role). Used by the
// email-draft send path so that after a successful send, the stored draft row
// reflects the values that were actually sent (not the agent's pre-edit text)
// plus a `sent: true` flag. Without this, a mobile-tab reconnect replays the
// original draft and the user can't tell what actually went out.
function updateMessageByTs(sessionId, ts, role, patch) {
  if (db) {
    try {
      const row = db.prepare("SELECT id, data FROM messages WHERE session_id = ? AND ts = ? AND role = ?").get(sessionId, Number(ts), role);
      if (row) {
        let obj; try { obj = JSON.parse(row.data); } catch { obj = {}; }
        const merged = { ...obj, ...patch };
        db.prepare("UPDATE messages SET data = ? WHERE id = ?").run(JSON.stringify(merged), row.id);
      }
    } catch (e) { console.error("[updateMessageByTs] sqlite failed:", e.message); }
  }
  try {
    const p = path.join(MESSAGES_DIR, sessionId + ".json");
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    let changed = false;
    for (let i = 0; i < arr.length; i++) {
      if (Number(arr[i].ts) === Number(ts) && arr[i].role === role) {
        arr[i] = { ...arr[i], ...patch };
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(p, JSON.stringify(arr));
  } catch (e) {
    if (e.code !== "ENOENT") console.error("[updateMessageByTs] JSON mirror failed:", e.message);
  }
}

function deleteMessages(sessionId) {
  if (db) {
    try { db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId); }
    catch (e) { console.error("[deleteMessages] sqlite failed:", e.message); }
  }
  try { fs.unlinkSync(path.join(MESSAGES_DIR, sessionId + ".json")); } catch {}
}
function deleteMessagesByTs(sessionId, tsList) {
  if (!Array.isArray(tsList) || !tsList.length) return 0;
  const tsSet = new Set(tsList.map(Number).filter(Number.isFinite));
  if (!tsSet.size) return 0;
  let removed = 0;
  if (db) {
    try {
      const stmt = db.prepare("DELETE FROM messages WHERE session_id = ? AND ts = ?");
      db.exec("BEGIN");
      try {
        for (const t of tsSet) {
          const r = stmt.run(sessionId, t);
          removed += r.changes || 0;
        }
        db.exec("COMMIT");
      } catch (inner) {
        try { db.exec("ROLLBACK"); } catch {}
        throw inner;
      }
    } catch (e) { console.error("[deleteMessagesByTs] sqlite failed:", e.message); }
  }
  try {
    const p = path.join(MESSAGES_DIR, sessionId + ".json");
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    const filtered = arr.filter(m => !tsSet.has(Number(m.ts)));
    if (filtered.length !== arr.length) fs.writeFileSync(p, JSON.stringify(filtered));
  } catch (e) {
    if (e.code !== "ENOENT") console.error("[deleteMessagesByTs] JSON mirror failed:", e.message);
  }
  return removed;
}

function ensureProjectTrusted(project) {
  try { fs.mkdirSync(path.join(CLAUDE_PROJECTS_DIR, "-home-claude-user-projects-" + project), { recursive: true }); } catch {}
}

// ---- Session store ----
function loadSessions() { try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch { return []; } }
function saveSessions(s) { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2)); }
// Update a single session object in the store (replaces the repeated
// `saveSessions(loadSessions().map(s => s.id === x.id ? x : s))` pattern).
function updateSessionInStore(session) {
  // Update-in-place. No-op for sessions that haven't been persisted yet
  // (pending placeholders that the user hasn't written to). Pending sessions
  // are promoted to disk explicitly via _persistSessionIfNew on first prompt.
  const sessions = loadSessions();
  const idx = sessions.findIndex(s => s.id === session.id);
  if (idx < 0) return;
  sessions[idx] = session;
  saveSessions(sessions);
}

function _persistSessionIfNew(session) {
  // Idempotent: writes the session record to disk if it isn't there yet.
  // The signal that "the user actually started this chat" — called from the
  // prompt handler before saving the first user message.
  const sessions = loadSessions();
  if (sessions.find(s => s.id === session.id)) return;
  sessions.unshift(session);
  saveSessions(sessions);
}

module.exports = {
  db,
  loadMessages, saveMessage, updateMessageByTs, deleteMessages, deleteMessagesByTs, ensureProjectTrusted,
  loadSessions, saveSessions, updateSessionInStore, _persistSessionIfNew,
};

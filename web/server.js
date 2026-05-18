const express = require("express");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.json());

// Force revalidation of JS/CSS so mobile browsers don't serve stale code
app.use((req, res, next) => {
  if (/\.(js|css|html)$/.test(req.path)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});


// Rewrite index.html on the fly to add ?v=<mtime> cache-busters on script/link tags.
// This makes every file change a new URL, defeating mobile browser disk cache.
function rewriteCacheBust(html, publicDir) {
  return html.replace(
    /(<(?:script|link)[^>]*?(?:src|href)=")([^"?]+\.(?:js|css))(")/g,
    (m, pre, file, post) => {
      try {
        const fs2 = require("fs");
        const st = fs2.statSync(path.join(publicDir, file));
        return pre + file + "?v=" + Math.floor(st.mtimeMs) + post;
      } catch { return m; }
    }
  );
}
app.get("/", (req, res) => {
  const pubDir = path.join(__dirname, "public");
  const idx = path.join(pubDir, "index.html");
  try {
    const html = fs.readFileSync(idx, "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(rewriteCacheBust(html, pubDir));
  } catch (e) {
    res.status(500).send("index error: " + e.message);
  }
});

app.use(express.static(path.join(__dirname, "public")));

const PROJECTS_DIR = "/home/claude-user/projects";
const DATA_DIR = "/home/claude-user/.llm-terminal";
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const MESSAGES_DIR = path.join(DATA_DIR, "messages");
const CLAUDE_PROJECTS_DIR = "/home/claude-user/.claude/projects";
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MESSAGES_DIR, { recursive: true });

// ---- SQLite message store ----
const { DatabaseSync } = require("node:sqlite");
const MESSAGES_DB_PATH = path.join(DATA_DIR, "messages.db");
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
      if (msg.role === "user") delete s.manualDone;
      saveSessions(sessions);
    }
  } catch {}
}
function deleteMessages(sessionId) {
  if (db) {
    try { db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId); }
    catch (e) { console.error("[deleteMessages] sqlite failed:", e.message); }
  }
  try { fs.unlinkSync(path.join(MESSAGES_DIR, sessionId + ".json")); } catch {}
}

function ensureProjectTrusted(project) {
  try { fs.mkdirSync(path.join(CLAUDE_PROJECTS_DIR, "-home-claude-user-projects-" + project), { recursive: true }); } catch {}
}

// ---- Session store ----
function loadSessions() { try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch { return []; } }
function saveSessions(s) { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2)); }

// ---- Image uploads ----
const activeProcs = new Set();
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function saveUploadedImage(base64Data, mimeType) {
  const ext = (mimeType || "image/png").includes("jpeg") || (mimeType || "").includes("jpg") ? ".jpg" : ".png";
  const name = "img_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex") + ext;
  const filePath = path.join(UPLOADS_DIR, name);
  fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
  return filePath;
}

// ---- Startup recovery: fix any sessions stuck from before restart ----
setTimeout(() => {
  const sessions = loadSessions();
  for (const session of sessions) {
    const msgs = loadMessages(session.id);
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") continue;
    const lastUserMsg = msgs[msgs.length - 1];
    if (Date.now() - lastUserMsg.ts < 30000) continue; // too fresh, might still be running

    console.log("[startup-recovery] retrying stuck session:", session.id);
    const cwd = path.join(PROJECTS_DIR, session.project);
    ensurePermissionsLoaded(session.id);
    const perms = sessionPermissions[session.id];
    killExistingClaudeFor(session.claudeSessionId);
    runClaude(
      { project: session.project, prompt: lastUserMsg.text, claudeSessionId: session.claudeSessionId, cwd, extraAllowedTools: perms ? [...perms] : [], model: session.model, sessionId: session.id },
      (data) => {
        if (data.type === "system" && data.subtype === "init" && data.session_id && !session.claudeSessionId) {
          session.claudeSessionId = data.session_id;
          saveSessions(loadSessions().map(s => s.id === session.id ? session : s));
        }
        if (data.type === "result" && data.result) {
          saveMessage(session.id, { role: "assistant", text: data.result, ts: Date.now(), recovered: true });
          console.log("[startup-recovery] recovered:", session.id);
          // Push to any connected client
          for (const client of wss.clients) {
            if (client.readyState === 1 && client._llmSessionId === session.id) {
              client.send(JSON.stringify({ type: "history", messages: loadMessages(session.id) }));
            }
          }
        }
      },
      (code) => { if (code !== 0) console.log("[startup-recovery] failed:", session.id, "code:", code); }
    );
  }
}, 5000);

// ---- Gmail Pub/Sub Webhook (replaces 5-min polling timer) ----
const GMAIL_POLLER_SCRIPT = path.join(__dirname, "scripts", "gmail-reply-poller.py");
let _gmailPollerRunning = false;

app.post("/webhooks/gmail", express.json(), (req, res) => {
  // Google Pub/Sub push delivery format:
  // { message: { data: "<base64>", messageId, publishTime }, subscription }
  // data decodes to: { emailAddress, historyId }
  res.status(200).send(); // ack immediately to avoid redelivery

  if (_gmailPollerRunning) return; // debounce concurrent notifications
  _gmailPollerRunning = true;

  const dataB64 = req.body?.message?.data;
  let emailAddress = "unknown";
  if (dataB64) {
    try {
      const decoded = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
      emailAddress = decoded.emailAddress || "unknown";
    } catch {}
  }
  console.log("[gmail-webhook] push notification for:", emailAddress);

  const child = spawn("python3", [GMAIL_POLLER_SCRIPT], {
    env: { ...process.env, LLMT_BASE_URL: "http://127.0.0.1:" + (process.env.PORT || 7683) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  child.on("close", (code) => {
    _gmailPollerRunning = false;
    if (out.trim()) console.log("[gmail-webhook] poller output:", out.trim());
    if (code !== 0) console.warn("[gmail-webhook] poller exited with code:", code);
  });
  // Safety timeout: unlock after 30s even if child hangs
  setTimeout(() => { _gmailPollerRunning = false; }, 30000);
});

// Watch renewal: call users.watch() on startup and every 6 days
const GMAIL_SETUP_SCRIPT = path.join(__dirname, "scripts", "gmail-pubsub-setup.py");
function renewGmailWatch() {
  const child = spawn("python3", [GMAIL_SETUP_SCRIPT, "--renew"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  child.on("close", () => { if (out.trim()) console.log("[gmail-watch]", out.trim()); });
}
setTimeout(renewGmailWatch, 10000); // 10s after startup
setInterval(renewGmailWatch, 6 * 24 * 60 * 60 * 1000); // every 6 days

// ---- API ----
app.get("/health", (_, res) => {
  const sessions = loadSessions();
  const stuck = sessions.filter(s => {
    const msgs = loadMessages(s.id);
    return msgs.length > 0 && msgs[msgs.length - 1].role === "user" && (Date.now() - msgs[msgs.length - 1].ts > 60000);
  });
  res.json({ status: "ok", sessions: sessions.length, stuck: stuck.length });
});
app.get("/api/projects", (_, res) => {
  // Skip symlinks so legacy compat symlinks (e.g. narrativeHero -> orchestratorHero)
  // do not show up as duplicate projects in the sidebar. Real dirs only.
  const dirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
    if (d.startsWith(".")) return false;
    try {
      const st = fs.lstatSync(path.join(PROJECTS_DIR, d));
      return st.isDirectory() && !st.isSymbolicLink();
    } catch { return false; }
  });
  res.json(dirs);
});
const ARCHIVE_INACTIVE_DAYS = 30;
app.get("/api/sessions", (req, res) => {
  let s = loadSessions();
  // project="ALL" returns every project; omitted/empty also returns all;
  // any other value filters to that one project (back-compat).
  const proj = req.query.project;
  if (proj && proj !== "ALL") s = s.filter(x => x.project === proj);
  // Annotate archived status — soft (computed on the fly), based on lastActive.
  const cutoff = Date.now() - ARCHIVE_INACTIVE_DAYS * 86400 * 1000;
  s = s.map(x => ({ ...x, archived: (x.lastActive || x.created || 0) < cutoff }));
  // Sort newest first within the result.
  s.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  res.json(s);
});

// Full-text search across message bodies. Returns session IDs whose messages
// contain the query. Frontend ORs this with title/project matching.
app.get("/api/search", (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q || q.length < 2) return res.json({ sessionIds: [] });
  if (q.length > 200) return res.status(400).json({ error: "query too long" });
  if (!db) return res.json({ sessionIds: [] });
  try {
    // LIKE escape: backslash quotes %, _, and \ itself.
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    const rows = db
      .prepare("SELECT DISTINCT session_id FROM messages WHERE data LIKE ? ESCAPE '\\' LIMIT 500")
      .all(`%${escaped}%`);
    res.json({ sessionIds: rows.map(r => r.session_id) });
  } catch (e) {
    console.error("[search] failed:", e.message);
    res.status(500).json({ error: "search failed" });
  }
});
app.delete("/api/sessions/:id", (req, res) => {
  saveSessions(loadSessions().filter(s => s.id !== req.params.id));
  deleteMessages(req.params.id);
  res.json({ ok: true });
});


app.post("/api/sessions/bulk-archive-done", express.json(), (req, res) => {
  const olderThanDays = Number(req.body?.olderThanDays || 7);
  const cutoff = Date.now() - olderThanDays * 86400 * 1000;
  const sessions = loadSessions();
  let n = 0;
  for (const s of sessions) {
    if (s.archived) continue;
    if (!s.manualDone && s.lastMessageRole !== "email_sent") continue;
    const ts = s.manualDone || s.lastActive || 0;
    if (ts > cutoff) continue;
    s.archived = true;
    n++;
  }
  if (n > 0) saveSessions(sessions);
  res.json({ ok: true, archived: n });
});

app.post("/api/sessions/:id/state", express.json(), (req, res) => {
  const id = req.params.id;
  const manualDone = !!req.body?.manualDone;
  const sessions = loadSessions();
  const s = sessions.find(x => x.id === id);
  if (!s) return res.status(404).json({ ok: false, error: "not found" });
  if (manualDone) {
    s.manualDone = Date.now();
  } else {
    delete s.manualDone;
  }
  saveSessions(sessions);
  res.json({ ok: true, manualDone: s.manualDone || null });
});

// Sets lastViewed=now on a session. Frontend calls this when you open the
// session so we can tell apart "you saw the assistant's reply" from "still
// waiting on you to read it".
app.post("/api/sessions/:id/viewed", (req, res) => {
  const id = req.params.id;
  const sessions = loadSessions();
  const s = sessions.find(x => x.id === id);
  if (!s) return res.status(404).json({ ok: false, error: "not found" });
  s.lastViewed = Date.now();
  saveSessions(sessions);
  res.json({ ok: true, lastViewed: s.lastViewed });
});

// Records the Gmail thread ID after a successful send so the reply poller
// can match inbound mail back to a session.
app.post("/api/sessions/:id/email-sent", express.json(), (req, res) => {
  const id = req.params.id;
  const threadId = (req.body?.threadId || "").trim();
  const account = (req.body?.account || "").trim();
  if (!threadId) return res.status(400).json({ ok: false, error: "threadId required" });
  const sessions = loadSessions();
  const s = sessions.find(x => x.id === id);
  if (!s) return res.status(404).json({ ok: false, error: "not found" });
  s.gmailThreadId = threadId;
  if (account) s.gmailAccount = account;
  // Initial cursor — anything that arrives AFTER this counts as a new reply.
  s.gmailLastSeenMs = Date.now();
  saveSessions(sessions);
  res.json({ ok: true });
});

// Appends an assistant message to a session. Used by the llmterminal MCP
// (llmt_complete with a summary) so the wrap-up shows up in the chat.
// Loopback only — no auth, intended for MCP tools running locally.
app.post("/api/sessions/:id/append-assistant", express.json(), (req, res) => {
  const id = req.params.id;
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "text required" });
  const sessions = loadSessions();
  const s = sessions.find(x => x.id === id);
  if (!s) return res.status(404).json({ ok: false, error: "not found" });
  const ts = Date.now();
  try {
    saveMessage(id, { role: "assistant", text, ts, source: "mcp_complete" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "saveMessage failed: " + e.message });
  }
  s.lastActive = ts;
  s.lastMessageRole = "assistant";
  s.lastSnippet = text.slice(0, 200);
  saveSessions(sessions);
  // Push to any connected client so the chat redraws immediately.
  try {
    for (const client of wss.clients) {
      if (client.readyState === 1 && client._llmSessionId === id) {
        client.send(JSON.stringify({ type: "history", messages: loadMessages(id) }));
      }
    }
  } catch {}
  res.json({ ok: true });
});

// Reply detected on a tracked thread — pull the session back to the top.
// Body: { fromEmail, subject, messageId, snippet, ts }
app.post("/api/sessions/:id/reactivate", express.json(), (req, res) => {
  const id = req.params.id;
  const sessions = loadSessions();
  const s = sessions.find(x => x.id === id);
  if (!s) return res.status(404).json({ ok: false, error: "not found" });
  const now = Date.now();
  const from = (req.body?.fromEmail || "someone").trim();
  const subject = (req.body?.subject || "").trim();
  const snippet = (req.body?.snippet || "").trim().slice(0, 200);
  const ts = Number(req.body?.ts) || now;
  s.lastActive = ts;
  s.lastMessageRole = "email_reply";
  s.lastSnippet = `📬 Reply from ${from}` + (subject ? ` — ${subject}` : "");
  s.gmailLastSeenMs = ts;
  delete s.manualDone; // a reply un-marks any "done" state
  saveSessions(sessions);
  // Append a synthetic message so the chat view shows it.
  try {
    saveMessage(id, {
      role: "email_reply",
      ts,
      text: `📬 Reply received from ${from}` + (subject ? ` — *${subject}*` : "") + (snippet ? `\n\n> ${snippet}` : ""),
      fromEmail: from, subject, messageId: req.body?.messageId || null,
    });
  } catch (e) { console.error("[reactivate] saveMessage failed:", e.message); }
  res.json({ ok: true });
});



// ---- Decision timeline / tree endpoints ----
// Append, resolve, fetch per session, fetch per project.
// Called via the llmterminal MCP server (llmt_decide, llmt_decide_resolve)
// running inside the claude spawn — loopback only, no auth.

function _arrText(x) {
  if (Array.isArray(x)) return JSON.stringify(x);
  if (typeof x === "string") return x;
  return null;
}
function _normalizeDecisionRow(row) {
  if (!row) return null;
  let alts, cons, arts;
  try { alts = row.alternatives ? JSON.parse(row.alternatives) : []; } catch { alts = []; }
  try { cons = row.constraints ? JSON.parse(row.constraints) : []; } catch { cons = []; }
  try { arts = row.artifacts ? JSON.parse(row.artifacts) : null; } catch { arts = null; }
  return {
    id: row.id,
    session_id: row.session_id,
    parent_id: row.parent_id,
    ts: row.ts,
    summary: row.summary,
    chose: row.chose,
    alternatives: alts,
    why: row.why,
    constraints: cons,
    cost: row.cost,
    status: row.status,
    artifacts: arts,
    mined: !!row.mined,
  };
}

app.post("/api/sessions/:id/decisions", express.json(), (req, res) => {
  const id = req.params.id;
  if (!db) return res.status(503).json({ ok: false, error: "db unavailable" });
  const summary = String(req.body?.summary || "").trim();
  const chose   = String(req.body?.chose   || "").trim();
  if (!summary || !chose) {
    return res.status(400).json({ ok: false, error: "summary and chose are required" });
  }
  const why   = String(req.body?.why   || "").trim() || null;
  const cost  = String(req.body?.cost  || "").trim() || null;
  const alts  = _arrText(req.body?.alternatives) || null;
  const cons  = _arrText(req.body?.constraints)  || null;
  let parentId = req.body?.parent_id;
  // If unspecified, link to the most recent decision in this session.
  if (parentId === undefined || parentId === null) {
    try {
      const last = db.prepare("SELECT id FROM decisions WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1").get(id);
      parentId = last ? last.id : null;
    } catch { parentId = null; }
  } else {
    parentId = Number(parentId) || null;
  }
  const ts = Date.now();
  const mined = req.body?.mined ? 1 : 0;
  try {
    const result = db
      .prepare("INSERT INTO decisions (session_id, parent_id, ts, summary, chose, alternatives, why, constraints, cost, status, artifacts, mined) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)")
      .run(id, parentId, ts, summary, chose, alts, why, cons, cost, mined);
    const newId = Number(result.lastInsertRowid);
    const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(newId);
    res.json({ ok: true, decision: _normalizeDecisionRow(row) });
  } catch (e) {
    console.error("[decisions] insert failed:", e.message);
    res.status(500).json({ ok: false, error: "insert failed" });
  }
});

app.post("/api/decisions/:did/status", express.json(), (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "db unavailable" });
  const did = Number(req.params.did);
  const status = String(req.body?.status || "").trim();
  const ALLOWED = new Set(["pending", "verified", "reversed", "mined"]);
  if (!ALLOWED.has(status)) {
    return res.status(400).json({ ok: false, error: "status must be one of " + [...ALLOWED].join("|") });
  }
  const artifact = req.body?.artifact;
  try {
    const existing = db.prepare("SELECT artifacts FROM decisions WHERE id = ?").get(did);
    if (!existing) return res.status(404).json({ ok: false, error: "decision not found" });
    let merged = null;
    if (artifact !== undefined && artifact !== null) {
      let obj;
      try { obj = existing.artifacts ? JSON.parse(existing.artifacts) : {}; } catch { obj = {}; }
      if (typeof artifact === "string") {
        const arr = Array.isArray(obj.notes) ? obj.notes : [];
        arr.push(artifact);
        obj.notes = arr;
      } else if (typeof artifact === "object") {
        Object.assign(obj, artifact);
      }
      merged = JSON.stringify(obj);
    }
    if (merged !== null) {
      db.prepare("UPDATE decisions SET status = ?, artifacts = ? WHERE id = ?").run(status, merged, did);
    } else {
      db.prepare("UPDATE decisions SET status = ? WHERE id = ?").run(status, did);
    }
    const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(did);
    res.json({ ok: true, decision: _normalizeDecisionRow(row) });
  } catch (e) {
    console.error("[decisions] update failed:", e.message);
    res.status(500).json({ ok: false, error: "update failed" });
  }
});

app.get("/api/sessions/:id/decisions", (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "db unavailable" });
  try {
    const rows = db.prepare("SELECT * FROM decisions WHERE session_id = ? ORDER BY ts ASC, id ASC").all(req.params.id);
    res.json({ decisions: rows.map(_normalizeDecisionRow) });
  } catch (e) {
    res.status(500).json({ ok: false, error: "query failed" });
  }
});

app.get("/api/projects/:name/decisions", (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "db unavailable" });
  try {
    // Sessions belong to projects via sessions.json — get all session ids for this project,
    // then fetch their decisions ordered globally.
    const sessions = loadSessions().filter(s => s.project === req.params.name);
    if (!sessions.length) return res.json({ decisions: [] });
    const idList = sessions.map(s => s.id);
    const placeholders = idList.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM decisions WHERE session_id IN (${placeholders}) ORDER BY ts ASC, id ASC`)
      .all(...idList);
    res.json({ decisions: rows.map(_normalizeDecisionRow) });
  } catch (e) {
    res.status(500).json({ ok: false, error: "query failed" });
  }
});

// ---- TTS proxy to OpenAI with disk cache ----
const TTS_CACHE_DIR = path.join(DATA_DIR, "tts-cache");
fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
const TTS_MODEL = "tts-1";
const TTS_VOICE_DEFAULT = "nova";
const TTS_MAX_CHARS = 4000;

app.post("/tts", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "missing text" });
    if (text.length > TTS_MAX_CHARS) return res.status(413).json({ error: "text too long (max " + TTS_MAX_CHARS + ")" });
    const voice = String(req.body?.voice || TTS_VOICE_DEFAULT);
    const hash = crypto.createHash("sha256").update(TTS_MODEL + "|" + voice + "|" + text).digest("hex");
    const cachePath = path.join(TTS_CACHE_DIR, hash + ".mp3");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("X-TTS-Hash", hash);
    res.setHeader("Cache-Control", "private, max-age=31536000");
    if (fs.existsSync(cachePath)) {
      res.setHeader("X-TTS-Cache", "hit");
      return fs.createReadStream(cachePath).pipe(res);
    }
    const key = process.env.OPENAI_API_KEY;
    if (!key) { console.error("[tts] OPENAI_API_KEY not set"); return res.status(503).json({ error: "OPENAI_API_KEY not set" }); }
    const t0 = Date.now();
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, voice, input: text, response_format: "mp3" })
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error("[tts] openai error", r.status, errText.slice(0, 500));
      return res.status(502).json({ error: "openai tts failed", status: r.status });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(cachePath, buf);
    console.log(`[tts] generated ${buf.length}B in ${Date.now()-t0}ms (voice=${voice}, chars=${text.length})`);
    res.setHeader("X-TTS-Cache", "miss");
    res.end(buf);
  } catch (err) {
    console.error("[tts] error:", err);
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// ---- Voice note upload + Whisper transcription ----
const VOICE_DIR = path.join(DATA_DIR, "voice-notes");
const QUEUE_DIR = path.join(DATA_DIR, "queue");
fs.mkdirSync(QUEUE_DIR, { recursive: true });

function queueFile(sessionId) {
  return path.join(QUEUE_DIR, sessionId + ".jsonl");
}
function queueAppend(sessionId, item) {
  // item = { text, ts, source }  (source = 'voice-note' | 'prompt' | etc.)
  if (!item.ts) item.ts = Date.now();
  try {
    fs.appendFileSync(queueFile(sessionId), JSON.stringify(item) + "\n");
    console.log("[queue] +1 for", sessionId, "(" + item.source + ")", item.text.slice(0, 60));
    return true;
  } catch (e) {
    console.error("[queue] append failed:", e.message);
    return false;
  }
}
function queueLoad(sessionId) {
  try {
    const raw = fs.readFileSync(queueFile(sessionId), "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function queueSaveAll(sessionId, items) {
  try {
    if (!items.length) {
      try { fs.unlinkSync(queueFile(sessionId)); } catch {}
      return;
    }
    fs.writeFileSync(queueFile(sessionId), items.map(JSON.stringify).join("\n") + "\n");
  } catch (e) { console.error("[queue] save failed:", e.message); }
}
function queuePopNext(sessionId) {
  const items = queueLoad(sessionId);
  if (!items.length) return null;
  const next = items.shift();
  queueSaveAll(sessionId, items);
  console.log("[queue] -1 for", sessionId, "(", items.length, "remaining):", next.text.slice(0, 60));
  return next;
}

fs.mkdirSync(VOICE_DIR, { recursive: true });

// Classify voice note transcript and auto-create orchestrator task if it's a new idea/direction
async function classifyAndCapture(transcript, title, sessionId, audioUrl) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 200,
      messages: [
        { role: "system", content: `You classify voice note transcripts. Decide if this is:
1. "reply" — a response to an ongoing conversation, a direct instruction to the current chat, a status update, OR meta-commentary about the chat itself
2. "idea" — a NEW concept, feature idea, architectural direction, bug report, or something that should be tracked as an independent task

IMPORTANT — these are ALWAYS "reply", never "idea":
- Requests to continue, complete, or clarify a previous response ("finish explaining", "complete the response", "clarify if...")
- Confirmations or follow-ups to something already discussed ("yes do that", "confirm X is included")
- References to what the AI just said or did ("the truncated response", "what you described")
- Meta-conversation about the chat session itself
- Vague fragments without a clear actionable outcome

Only classify as "idea" when the transcript describes something NEW to build, fix, change, or investigate — independent of the current conversation. When in doubt, classify as "reply".

If "idea", also extract:
- title: 5-10 word task title (must describe a concrete action, not a conversation continuation)
- description: 1-2 sentence summary of what needs to happen
- project: which project this relates to (narrativehero, crankhero, datahero, llmterminal, mediahero, oshero, or unknown)
- priority: low, normal, high, or urgent

Respond as JSON: {"type":"reply"} or {"type":"idea","title":"...","description":"...","project":"...","priority":"..."}` },
        { role: "user", content: transcript.slice(0, 2000) }
      ]
    })
  });
  if (!r.ok) return;
  const data = await r.json();
  const content = (data.choices?.[0]?.message?.content || "").trim();
  let parsed;
  try { parsed = JSON.parse(content); } catch { return; }
  if (parsed.type !== "idea") return;

  // Create task in orchestrator
  console.log(`[auto-capture] new idea detected: "${parsed.title}" (project: ${parsed.project})`);
  try {
    const orchRes = await fetch(ORCH_BASE + "/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: parsed.title || title,
        description: (parsed.description || "") + "\n\n[Auto-captured from voice note" + (sessionId ? " in session " + sessionId : "") + "]\nAudio: " + audioUrl + "\n\nOriginal transcript:\n" + transcript.slice(0, 3000),
        project_id: parsed.project || "unknown",
        priority: parsed.priority || "normal",
        owner: "operator"
      })
    });
    if (orchRes.ok) {
      const task = await orchRes.json();
      console.log(`[auto-capture] created task ${task.task_id || "?"}: "${parsed.title}"`);
    } else {
      console.warn("[auto-capture] orchestrator rejected:", orchRes.status);
    }
  } catch (e) {
    console.warn("[auto-capture] orchestrator unreachable:", e.message);
  }
}

app.post("/voice-note", express.raw({ type: ["audio/*", "application/octet-stream"], limit: "25mb" }), async (req, res) => {
  try {
    if (!req.body || req.body.length === 0) return res.status(400).json({ error: "no audio data" });
    const ct = (req.headers["content-type"] || "").toLowerCase();
    const ext = ct.includes("webm") ? ".webm"
              : ct.includes("mp4") || ct.includes("m4a") || ct.includes("aac") || ct.includes("x-m4a") ? ".m4a"
              : ct.includes("ogg") ? ".ogg"
              : ct.includes("wav") ? ".wav" : ".m4a"; // default m4a — Safari/iOS most common
    const name = "vn_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex") + ext;
    const filePath = path.join(VOICE_DIR, name);
    fs.writeFileSync(filePath, req.body);
    console.log(`[voice-note] saved ${req.body.length}B -> ${name}`);

    // Transcribe with OpenAI Whisper
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      console.error("[voice-note] OPENAI_API_KEY not set");
      return res.json({ audioUrl: "/voice-notes/" + name, transcript: null, error: "OPENAI_API_KEY not set" });
    }
    const t0 = Date.now();
    const boundary = "----VNBoundary" + crypto.randomBytes(8).toString("hex");
    const fileContent = fs.readFileSync(filePath);
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${ext === ".m4a" ? "audio/mp4" : "audio/" + ext.slice(1)}\r\n\r\n`,
      fileContent,
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`,
      `\r\n--${boundary}--\r\n`
    ];
    const body = Buffer.concat(parts.map(p => typeof p === "string" ? Buffer.from(p) : p));
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "multipart/form-data; boundary=" + boundary,
      },
      body
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error("[voice-note] whisper error", r.status, errText.slice(0, 500));
      return res.json({ audioUrl: "/voice-notes/" + name, transcript: null, error: "transcription failed" });
    }
    const result = await r.json();
    console.log(`[voice-note] transcribed in ${Date.now()-t0}ms: "${(result.text || "").slice(0, 80)}..."`);
    // If sessionId provided, write the transcript directly to that session's persistent queue.
    // This guarantees the prompt is recorded server-side even if the client crashes / refreshes
    // before sending it.
    const sid = (req.query && req.query.session) || "";
    if (sid && result.text) {
      queueAppend(sid, { text: result.text, source: "voice-note", audioUrl: "/voice-notes/" + name });
      // Try to drain immediately if the session isn't currently running anything
      try { tryDrainQueue(sid); } catch (e) { console.error("[queue] drain attempt failed:", e.message); }
    }
    // Generate a short title from the transcript
    let title = "";
    const transcript = result.text || "";
    if (transcript.length > 10) {
      try {
        const tr = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            max_tokens: 30,
            messages: [
              { role: "system", content: "Generate a 3-7 word title summarizing this voice note. No quotes, no punctuation at the end. Just the title." },
              { role: "user", content: transcript.slice(0, 1000) }
            ]
          })
        });
        if (tr.ok) {
          const tj = await tr.json();
          title = (tj.choices?.[0]?.message?.content || "").trim();
          console.log(`[voice-note] title: "${title}"`);
        }
      } catch (e) { console.warn("[voice-note] title gen failed:", e.message); }
    }
    // Async: classify if this voice note contains a new idea/task
    // Don't block the response — fire and forget
    if (transcript.length > 30) {
      classifyAndCapture(transcript, title, sid, "/voice-notes/" + name).catch(e =>
        console.warn("[voice-note] classify failed:", e.message)
      );
    }
    res.json({ audioUrl: "/voice-notes/" + name, transcript, title });
  } catch (err) {
    console.error("[voice-note] error:", err);
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

// Serve voice note audio files
app.use("/voice-notes", express.static(VOICE_DIR));

// ---- Orchestrator task board proxy (narrativeHero :8000) ----
const ORCH_BASE = "http://localhost:8000/api/orchestrator";

// Drafts-only policy: send_gmail_email.py refuses to run without this token.
// We read it once at startup and inject into the spawn env for /api/email-draft/send only.
let LLMT_SEND_TOKEN = "";
try {
  LLMT_SEND_TOKEN = require("fs").readFileSync("/home/claude-user/.camohero-send/llmt-token", "utf8").trim();
} catch (e) {
  console.error("[email-draft] WARNING: cannot read send-auth token:", e.message);
}

// Create a new task — proxies to narrativeHero orchestrator queue/create
app.post("/api/tasks", express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.title) return res.status(400).json({ error: "title required" });
    const r = await fetch(ORCH_BASE + "/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return res.status(r.status).json({ error: "orchestrator create failed", status: r.status });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "orchestrator unreachable", detail: String(err.message || err) });
  }
});

app.get("/api/tasks", async (req, res) => {
  try {
    const qs = new URLSearchParams();
    if (req.query.status) qs.set("status", req.query.status);
    if (req.query.project_id) qs.set("project_id", req.query.project_id);
    qs.set("limit", req.query.limit || "100");
    const r = await fetch(ORCH_BASE + "/queue/items?" + qs);
    if (!r.ok) return res.status(r.status).json({ error: "orchestrator error" });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "orchestrator unreachable", detail: String(err.message || err) });
  }
});

app.get("/api/tasks/summary", async (_req, res) => {
  try {
    const r = await fetch(ORCH_BASE + "/queue/summary");
    if (!r.ok) return res.status(r.status).json({ error: "orchestrator error" });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "orchestrator unreachable", detail: String(err.message || err) });
  }
});

app.post("/api/tasks/:id/transition", express.json(), async (req, res) => {
  try {
    const r = await fetch(ORCH_BASE + "/queue/items/" + req.params.id + "/transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });
    if (!r.ok) return res.status(r.status).json({ error: "transition failed" });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "orchestrator unreachable", detail: String(err.message || err) });
  }
});

// ---- Auto-retry blocked tasks every 5 minutes ----
// Tasks with runner_exit=127 or similar transient failures get requeued automatically
async function autoRetryBlockedTasks() {
  try {
    const r = await fetch(ORCH_BASE + "/queue/items?status=blocked&limit=50");
    if (!r.ok) return;
    const data = await r.json();
    const retryable = (data.items || []).filter(t => {
      const reason = (t.blocked_reason || "").toLowerCase();
      // Auto-retry: runner failures, timeouts, transient errors
      return reason.includes("runner_exit") || reason.includes("timeout") || reason.includes("transient");
    });
    for (const t of retryable) {
      try {
        await fetch(ORCH_BASE + "/queue/items/" + t.task_id + "/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ detail: "Auto-retried by llmTerminal supervisor" })
        });
        console.log("[auto-retry] requeued:", t.task_id, t.title.slice(0, 40));
      } catch {}
    }
    if (retryable.length) console.log("[auto-retry] requeued " + retryable.length + " blocked tasks");
  } catch (e) {
    console.warn("[auto-retry] failed:", e.message);
  }
}
// Auto-verify email drafts by cross-referencing with sent log
async function autoVerifyEmails() {
  try {
    const sessions = loadSessions();
    const emailSessions = sessions.filter(s => !s.manualDone && s.lastMessageRole === "email_draft");
    if (!emailSessions.length) return;
    const sentEntries = [];
    try {
      const lines = fs.readFileSync(SENT_LOG_PATH, "utf8").trim().split("\n");
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const line of lines) {
        try { const e = JSON.parse(line); if (new Date(e.sent_at).getTime() > cutoff) sentEntries.push(e); } catch {}
      }
    } catch { return; }
    let done = 0;
    for (const s of emailSessions) {
      const match = sentEntries.find(e =>
        (e.sessionId && e.sessionId === s.id) ||
        (s.title && e.subject && s.title.toLowerCase().includes(e.subject.toLowerCase().slice(0, 30)))
      );
      if (match) { s.emailOpened = match.sent_at; s.manualDone = Date.now(); done++; }
    }
    if (done) { saveSessions(sessions); console.log("[email-verify] " + done + " email sessions auto-marked done"); }
  } catch (e) { console.warn("[email-verify]", e.message); }
}

// Run on startup after 30s, then every 5 minutes
setTimeout(() => { autoRetryBlockedTasks(); autoVerifyEmails(); }, 30000);
setInterval(() => { autoRetryBlockedTasks(); autoVerifyEmails(); }, 5 * 60 * 1000);

// ---- Per-session granted permissions (persisted to disk) ----
const PERMISSIONS_DIR = path.join(DATA_DIR, "permissions");
fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });


// ---- /api/browser-status ----
// Reports per-project browser status (running, tab count, current URL, activity level).
// Tracks URL/title/tab changes to classify activity as: navigating (just changed),
// active (changed in last minute), idle (unchanged 1-10 min), dormant (>10 min).
/* >>> llmTerminal-managed (do not edit between markers) >>> */
// BROWSER_CDP_PORTS regenerated by sync-config.py
const BROWSER_CDP_PORTS = {
  camohero: 9222,
  crankhero: 9223,
  orchestratorhero: 9224,
  llmterminal: 9225,
};
/* <<< llmTerminal-managed <<< */
const browserActivity = {}; // proj -> { sig, lastChange, firstSeen }
app.get('/api/browser-status', async (req, res) => {
  const proj = String(req.query.project || '').toLowerCase();
  const port = BROWSER_CDP_PORTS[proj];
  if (!port) return res.json({ running: false, tabs: 0, url: null, error: 'unknown project' });
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error('cdp ' + r.status);
    const tabs = await r.json();
    const pages = tabs.filter(t => t.type === 'page');
    const top = pages[0];
    const url = top ? top.url : null;
    const title = top ? top.title : null;

    // Track changes: URL OR title OR tab count flipping counts as activity
    const sig = JSON.stringify({ url, title, n: pages.length });
    const now = Date.now();
    const prev = browserActivity[proj];
    if (!prev || prev.sig !== sig) {
      browserActivity[proj] = { sig, lastChange: now, firstSeen: (prev && prev.firstSeen) || now };
    }
    const lastChange = browserActivity[proj].lastChange;
    const idleMs = now - lastChange;
    let activity;
    if (idleMs < 10000) activity = 'navigating';
    else if (idleMs < 60000) activity = 'active';
    else if (idleMs < 600000) activity = 'idle';
    else activity = 'dormant';

    res.json({
      running: true,
      tabs: pages.length,
      url, title,
      activity,
      idleSec: Math.round(idleMs / 1000),
    });
  } catch (e) {
    res.json({ running: false, tabs: 0, url: null, error: e.message });
  }
});


// ---- noVNC browser viewer served at /vnc/ ----
// Serves noVNC static files and proxies the WebSocket to the llmterminal websockify (port 6083).
const NOVNC_WS_PORT = 6083;
app.use('/vnc', express.static('/usr/share/novnc'));
// WebSocket proxy: forward /vnc/websockify upgrades to websockify at port 6083
const net = require("net");
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') return; // let the main WSS handle /ws
  if (req.url.startsWith('/vnc/websockify') || req.url.startsWith('/websockify')) {
    const target = net.createConnection(NOVNC_WS_PORT, '127.0.0.1', () => {
      // Forward the raw HTTP upgrade request to websockify
      target.write(
        req.method + ' /websockify HTTP/' + req.httpVersion + '\r\n' +
        Object.entries(req.headers).map(([k,v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n'
      );
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  }
});

// ---- /api/email-draft/send ----
// camoHero-only. Shells out to camoHero/scripts/send_gmail_email.py (no --dry-run)
// after validating the session belongs to the camoHero project. Honors the same
// pre-send checks (sign-off / URL trust / dedup) as a CLI invocation.
app.post("/api/email-draft/send", express.json(), (req, res) => {
  const { sessionId, to, cc, subject, body, fromAccount, threadId, attachments, force } = req.body || {};
  if (!sessionId || !to || !subject || !body) {
    return res.status(400).json({ ok: false, error: "missing fields (sessionId, to, subject, body required)" });
  }
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ ok: false, error: "session not found" });
  if (session.project !== "camoHero") {
    return res.status(403).json({ ok: false, error: "send button is only enabled for camoHero sessions" });
  }
  const account = (fromAccount && /^[a-z0-9_-]+$/.test(fromAccount)) ? fromAccount : "camofiles";
  const args = [
    "/home/claude-user/projects/camoHero/scripts/send_gmail_email.py",
    "--from", account,
    "--to", to,
    "--subject", subject,
    "--body", body,
  ];
  if (cc) { args.push("--cc", cc); }
  if (threadId && /^[A-Za-z0-9_-]+$/.test(threadId)) { args.push("--thread-id", threadId); }
  // Attachments: validate each path is absolute, exists, and lives under camoHero project dir
  if (Array.isArray(attachments) && attachments.length) {
    const path = require("path");
    const fsx = require("fs");
    const ALLOWED_PREFIX = "/home/claude-user/projects/camoHero/";
    for (const ap of attachments) {
      if (typeof ap !== "string") {
        return res.status(400).json({ ok: false, error: "attachment must be a string path" });
      }
      const abs = path.resolve(ap);
      if (!abs.startsWith(ALLOWED_PREFIX)) {
        return res.status(400).json({ ok: false, error: `attachment outside allowed dir: ${ap}` });
      }
      if (!fsx.existsSync(abs)) {
        return res.status(400).json({ ok: false, error: `attachment not found: ${ap}` });
      }
      args.push("--attach", abs);
    }
  }
  if (force === true) { args.push("--force"); }
  const proc = spawn("/usr/bin/python3", args, {
    cwd: "/home/claude-user/projects/camoHero",
    uid: 1000, gid: 1000,
    env: { HOME: "/home/claude-user", PATH: process.env.PATH, LANG: "en_US.UTF-8", LLMT_SEND_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "", stderr = "";
  proc.stdout.on("data", c => { stdout += c.toString(); });
  proc.stderr.on("data", c => { stderr += c.toString(); });
  proc.on("close", (code) => {
    if (code === 0) {
      const m = stdout.match(/Message ID: (\S+)/);
      const tm = stdout.match(/Thread ID:\s*([A-Za-z0-9_-]+)/);
      saveMessage(sessionId, { role: "email_sent", to, cc: cc || "", subject, account, message_id: m ? m[1] : null, ts: Date.now() });
      // Track the Gmail thread on the session so the reply poller can match replies.
      try {
        const sessions = loadSessions();
        const ss = sessions.find(x => x.id === sessionId);
        if (ss) {
          if (tm) ss.gmailThreadId = tm[1];
          ss.gmailAccount = account;
          ss.gmailLastSeenMs = Date.now();
          saveSessions(sessions);
        }
      } catch (e) { console.error("[email-draft/send] thread track failed:", e.message); }
      res.json({ ok: true, message_id: m ? m[1] : null, thread_id: tm ? tm[1] : null, account, output: stdout.slice(-2000) });
    } else {
      // Surface the most useful line of the failure (BLOCKED [...] line) to the UI
      const blocked = stdout.match(/BLOCKED[^\n]+|WARNING[^\n]+/);
      res.status(400).json({
        ok: false, code,
        error: blocked ? blocked[0] : (stderr.split("\n").pop() || "send failed"),
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
      });
    }
  });
  proc.on("error", (e) => {
    res.status(500).json({ ok: false, error: "spawn failed: " + e.message });
  });
});



// ---- /api/file ----
// Serves camoHero project files and upload attachments for preview/iframe rendering.
// Path must be under an explicit allowlist — never traverses outside.
const FILE_SERVE_ALLOWLIST = [
  '/home/claude-user/projects/',           // any project dir (camoHero, crankHero, llmTerminal, etc.)
  '/home/claude-user/.llm-terminal/uploads/',
  '/home/claude-user/.llm-terminal/voice-notes/',  // serve voice notes for inline audio playback
];
const FILE_SERVE_MIME = {
  '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.csv': 'text/csv', '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.webm': 'audio/webm',
};
app.get('/api/file', (req, res) => {
  const raw = String(req.query.path || '');
  if (!raw) return res.status(400).json({ error: 'path required' });
  const abs = path.resolve(raw);
  if (!FILE_SERVE_ALLOWLIST.some(p => abs.startsWith(p))) return res.status(403).json({ error: 'path not allowed' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });
  const ext = path.extname(abs).toLowerCase();
  const mime = FILE_SERVE_MIME[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(abs).pipe(res);
});

// ---- Open-in-Gmail intent log ----
// Written when the user taps an external-compose button on the action card,
// in the same JSONL camoHero/data/sent_log.py reads for cross-channel dedup.
// The hash functions mirror camoHero/data/sent_log.py exactly — keep in sync.
const _crypto = require("crypto");
const SENT_LOG_PATH = "/home/claude-user/projects/dataHero/.credentials/gmail_sent_log.jsonl";

function _sentLogKey(to, subject) {
  const raw = `${(to || "").toLowerCase().trim()}|${(subject || "").toLowerCase().trim()}`;
  return _crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}
function _bodyHash(body) {
  let clean = (body || "").toLowerCase().trim();
  for (const marker of ["best,", "cheers,", "camofileshero", "-- \n"]) {
    const idx = clean.lastIndexOf(marker);
    if (idx > 0) clean = clean.slice(0, idx);
  }
  return _crypto.createHash("sha256").update(clean).digest("hex").slice(0, 24);
}

app.post("/api/email-draft/log-intent", express.json(), (req, res) => {
  const { sessionId, to, cc, subject, body, channel } = req.body || {};
  if (!to || !subject) {
    return res.status(400).json({ ok: false, error: "to + subject required" });
  }
  const session = (loadSessions() || []).find(s => s.id === sessionId);
  const project = session?.project || "";
  const entry = {
    key: _sentLogKey(to, subject),
    body_hash: _bodyHash(body || ""),
    to,
    cc: cc || "",
    subject,
    message_id: null,
    thread_id: null,
    sent_at: new Date().toISOString(),
    sent_by: "open_in_gmail_intent",
    channel: channel || "open_in_gmail",
    project,
    sessionId: sessionId || "",
    from_account: "(manual via " + (channel || "Gmail UI") + ")",
    from_email: "",
  };
  try {
    fs.appendFileSync(SENT_LOG_PATH, JSON.stringify(entry) + "\n");
    // Auto-mark session as done — user opened email externally
    if (sessionId) {
      const sessions = loadSessions();
      const s = sessions.find(x => x.id === sessionId);
      if (s) {
        s.emailOpened = Date.now();
        s.manualDone = Date.now();
        saveSessions(sessions);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


const sessionPermissions = {}; // sessionId -> Set of permission strings

function loadPermissions(sessionId) {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(PERMISSIONS_DIR, sessionId + ".json"), "utf8"))); }
  catch { return new Set(); }
}
function savePermissions(sessionId) {
  const perms = sessionPermissions[sessionId];
  if (perms) fs.writeFileSync(path.join(PERMISSIONS_DIR, sessionId + ".json"), JSON.stringify([...perms]));
}
function ensurePermissionsLoaded(sessionId) {
  if (!sessionPermissions[sessionId]) sessionPermissions[sessionId] = loadPermissions(sessionId);
}

// ---- Auto-preview file writes ----
// When the agent uses Write/Edit/MultiEdit, post a preview to narrativeHero
// so the file shows up in the Files drawer without the agent having to do it.
// Track file_path -> preview_id per session so we update instead of duplicating
const previewMap = {}; // "sessionId:filePath" -> previewId

// Compact summary of a tool_use for the history log
function summarizeToolUse(toolName, input) {
  try {
    input = input || {};
    if (toolName === "Bash") return (input.command || "").slice(0, 140);
    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") return input.file_path || "(file)";
    if (toolName === "Read") return input.file_path || "(file)";
    if (toolName === "Glob") return input.pattern || "";
    if (toolName === "Grep") return (input.pattern || "") + (input.path ? " in " + input.path : "");
    if (toolName === "WebFetch" || toolName === "WebSearch") return input.url || input.query || "";
    if (toolName.startsWith("mcp__")) {
      const parts = toolName.split("__");
      return (parts[1] || "") + ":" + (parts[2] || "");
    }
  } catch {}
  return "";
}

function autoCreatePreview({ tool_name, input }, sessionId) {
  try {
    const filePath = input?.file_path;
    if (!filePath) return;
    let content = "";
    if (tool_name === "Write" && typeof input.content === "string") {
      content = input.content;
    } else {
      try { content = fs.readFileSync(filePath, "utf8"); } catch (e) { console.error("[auto-preview] read failed:", filePath, e.message); return; }
    }
    const title = path.basename(filePath);
    const mapKey = sessionId + ":" + filePath;
    const existingId = previewMap[mapKey];
    const body = JSON.stringify({
      type: "file",
      title,
      content: { body_text: content },
      session_id: sessionId,
    });
    // PUT to update if we already created a preview for this file, else POST
    const method = existingId ? "PUT" : "POST";
    const apiPath = existingId ? "/api/previews/" + existingId : "/api/previews";
    const req = http.request({
      hostname: "127.0.0.1",
      port: 8000,
      path: apiPath,
      method,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.id && !existingId) {
            previewMap[mapKey] = json.id;
            console.log("[auto-preview] created", json.id, "for", title);
          } else if (existingId) {
            console.log("[auto-preview] updated", existingId, "for", title);
          }
        } catch {}
      });
    });
    req.on("error", (e) => console.error("[auto-preview] failed:", e.message));
    req.write(body);
    req.end();
  } catch (e) {
    console.error("[auto-preview] error:", e.message);
  }
}





function autoDetectBashFiles(stdout, sessionId, cwd) {
  const EXT_TEXT = new Set(['.html','.htm','.md','.py','.json','.yaml','.yml','.csv','.txt']);
  const EXT_BIN  = new Set(['.pdf','.png','.jpg','.jpeg','.gif','.svg','.mp3','.wav','.m4a','.ogg','.webm']);
  const ALL_EXT_GROUP = '(?:html|htm|md|py|json|yaml|yml|csv|txt|pdf|png|jpg|jpeg|gif|svg|mp3|wav|m4a|ogg|webm)';
  const found = new Set();
  // Explicit PREVIEW: lines take priority
  for (const m of stdout.matchAll(/^PREVIEW:(.+)$/gm)) found.add(m[1].trim());
  // Scan for absolute paths under any project dir with known extensions
  for (const m of stdout.matchAll(/\/home\/claude-user\/projects\/[a-zA-Z0-9_-]+\/[^\s\\)\]>,.;]+/g)) {
    const p = m[0].replace(/[\)\]>,.;]+$/, '');
    const ext = require('path').extname(p).toLowerCase();
    if (EXT_TEXT.has(ext) || EXT_BIN.has(ext)) found.add(p);
  }
  // Scan for relative paths and resolve against the Bash cwd. Common case:
  // `python3 -c "...write_pdf('invoices/SQ-001.pdf')"` prints `invoices/SQ-001.pdf`
  // with no /home/... prefix. We only accept the path if (a) cwd is provided,
  // (b) the resolved path is still under /home/claude-user/projects/, and
  // (c) fs.existsSync confirms it. The existsSync gate kills false positives
  // from random "foo/bar.py" strings in usage messages.
  if (cwd && cwd.startsWith('/home/claude-user/projects/')) {
    const relRe = new RegExp("(^|[\\s\\(\\[\\\"'`])([\\w.-]+(?:/[\\w.-]+)+\\." + ALL_EXT_GROUP + ")(?=[\\s\\)\\]\\\"'`,;:]|$)", 'gmi');
    for (const m of stdout.matchAll(relRe)) {
      const rel = m[2];
      if (rel.startsWith('/') || rel.startsWith('..')) continue;
      const abs = require('path').resolve(cwd, rel);
      if (!abs.startsWith('/home/claude-user/projects/')) continue;
      found.add(abs);
    }
  }
  for (const filePath of found) {
    if (!fs.existsSync(filePath)) continue;
    const mapKey = sessionId + ':' + filePath;
    if (previewMap[mapKey]) continue;
    const ext = require('path').extname(filePath).toLowerCase();
    const isBin = EXT_BIN.has(ext);
    let bodyText;
    if (isBin) {
      bodyText = 'FILE_PATH:' + filePath;
    } else {
      try { bodyText = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    }
    const title = require('path').basename(filePath);
    const body = JSON.stringify({ type: 'file', title, content: { body_text: bodyText }, session_id: sessionId });
    const req = http.request({
      hostname: '127.0.0.1', port: 8000, path: '/api/previews', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { const json = JSON.parse(data); if (json.id) { previewMap[mapKey] = json.id; console.log('[bash-preview] registered', json.id, 'for', title); } } catch {}
      });
    });
    req.on('error', e => console.error('[bash-preview] failed:', e.message));
    req.write(body); req.end();
  }
}


// ── End-of-run observer (Tier 2 "supervisor pattern") ──
// After each agent run completes, fire a cheap Haiku call to read the recent
// messages and identify anything David asked for that the agent didn't address.
// Creates tasks with status "review" on the narrativeHero orchestrator queue.
// Fire-and-forget, doesn't block the user's chat. Skipped if too soon since last run.
const _observerLastRun = {};  // sessionId -> ts of last observer fire
const OBSERVER_COOLDOWN_MS = 30000;  // don't re-observe a session within 30s
const OBSERVER_MIN_MESSAGES = 4;     // skip if conversation is trivial
const OBSERVER_MODEL = "haiku";

function spawnObserver(sessionId, projectName) {
  try {
    if (!sessionId) return;
    const now = Date.now();
    if (_observerLastRun[sessionId] && (now - _observerLastRun[sessionId]) < OBSERVER_COOLDOWN_MS) return;
    _observerLastRun[sessionId] = now;

    // Load the most recent N messages for context
    const all = loadMessages(sessionId);
    if (all.length < OBSERVER_MIN_MESSAGES) return;
    const recent = all.slice(-25);  // bound prompt size

    // Build a compact conversation log
    const lines = recent.map(m => {
      const r = (m.role || "").toUpperCase();
      const t = m.text || m.summary || "";
      if (!t || r === "TOOL_ACTIVITY") return null;
      return `${r}: ${String(t).slice(0, 600)}`;
    }).filter(Boolean).join("\n\n");
    if (lines.length < 50) return;

    const prompt = `You are observing a chat between David (user) and an agent. Read the recent messages and identify any items David ASKED FOR that the agent did NOT clearly address or complete. Skip items the agent finished.

Output JSON ONLY (no prose, no markdown fences). If everything was addressed, output {"tasks":[]}. Otherwise:
{"tasks":[{"title":"short imperative","description":"more context, why it matters, what exact request from David","priority":"normal"}]}

Rules:
- Title: 5-12 words, imperative ("Add ...", "Fix ...", "Investigate ...")
- Description: include David's actual wording where possible
- Skip ideas the agent ALREADY DID
- Skip generic suggestions — only things David specifically asked for
- Max 3 tasks; pick the most concrete unfinished ones

Recent conversation:
${lines}`;

    console.log("[observer] firing for", sessionId, "(", recent.length, "msgs )");
    // Fire-and-forget: spawn a detached claude -p with Haiku, disabled tools, no file I/O
    const args = [
      "-p", prompt,
      "--model", OBSERVER_MODEL,
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--disallowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "NotebookEdit", "MultiEdit", "WebFetch", "WebSearch",
    ];
    const proc = spawn("/usr/bin/claude", args, {
      env: { HOME: "/home/claude-user", PATH: process.env.PATH, LANG: "en_US.UTF-8" },
      uid: 1000, gid: 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    proc.stdout.on("data", c => out += c);
    proc.stderr.on("data", c => err += c);
    const timer = setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, 45000);
    proc.on("close", async () => {
      clearTimeout(timer);
      try {
        const wrap = JSON.parse(out);
        const text = (wrap.result || wrap.text || out).toString();
        // Strip optional code fences
        const json = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
        const parsed = JSON.parse(json);
        const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        if (!tasks.length) { console.log("[observer]", sessionId, "→ no unaddressed items"); return; }
        // POST each task to our own endpoint
        for (const t of tasks.slice(0, 3)) {
          if (!t.title) continue;
          try {
            const r = await fetch("http://127.0.0.1:7683/api/tasks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: String(t.title).slice(0, 140),
                description: String(t.description || "").slice(0, 2000) + "\n\n— observed from session " + sessionId,
                project_id: (projectName || "").toLowerCase(),
                priority: t.priority || "normal",
              }),
            });
            const data = await r.json();
            console.log("[observer] +task:", t.title.slice(0, 60), "id=" + (data.item?.task_id || "?"));
          } catch (e) {
            console.error("[observer] task POST failed:", e.message);
          }
        }
      } catch (e) {
        console.warn("[observer] parse failed for", sessionId, "—", e.message, "raw:", out.slice(0, 300));
      }
    });
    proc.on("error", e => console.error("[observer] spawn error:", e.message));
  } catch (e) {
    console.error("[observer] outer error:", e.message);
  }
}

// ── Decision extractor (supervisor-pattern observer #2) ──
// Workers don't self-instrument their decisions — they shouldn't have to.
// Instead, after each run a separate cheap Haiku call reads the recent
// transcript and extracts decisions the worker made: forks where it picked
// between alternatives and closed off paths. Records each via the same
// /api/sessions/:id/decisions endpoint with mined=true so the user knows
// these are extracted, not explicitly declared.
const _decisionExtractorLastRun = {};   // sessionId -> ts of last extractor run
const _decisionHighWaterTs      = {};   // sessionId -> last ts we extracted past
const DECISION_EXTRACTOR_COOLDOWN_MS = 30000;
const DECISION_EXTRACTOR_MIN_MESSAGES = 4;

function spawnDecisionExtractor(sessionId, projectName) {
  try {
    if (!sessionId) return;
    const now = Date.now();
    if (_decisionExtractorLastRun[sessionId] && (now - _decisionExtractorLastRun[sessionId]) < DECISION_EXTRACTOR_COOLDOWN_MS) return;
    _decisionExtractorLastRun[sessionId] = now;

    const all = loadMessages(sessionId);
    if (all.length < DECISION_EXTRACTOR_MIN_MESSAGES) return;

    // Only consider messages newer than the last extraction high-water mark.
    const hwm = _decisionHighWaterTs[sessionId] || 0;
    const recent = all.filter(m => (m.ts || 0) > hwm).slice(-40);
    if (recent.length < 2) return;

    const lines = recent.map(m => {
      const r = (m.role || "").toUpperCase();
      let t = m.text || m.summary || "";
      if (r === "TOOL_ACTIVITY") {
        // Keep tool activity but truncate hard
        t = `(${m.tool_name || "tool"}) ${t}`.slice(0, 200);
      } else {
        t = String(t).slice(0, 800);
      }
      if (!t) return null;
      return `${r}: ${t}`;
    }).filter(Boolean).join("\n\n");
    if (lines.length < 80) return;

    // Pull last few already-recorded decisions for dedup hint.
    let prevSummary = "";
    try {
      const prev = db.prepare("SELECT summary, chose FROM decisions WHERE session_id = ? ORDER BY ts DESC LIMIT 8").all(sessionId);
      if (prev.length) {
        prevSummary = "\nAlready recorded (DO NOT duplicate these):\n" + prev.map(p => `  - ${p.summary} → chose: ${p.chose}`).join("\n");
      }
    } catch {}

    const prompt = `You are a supervisor agent observing a chat between a user and a worker agent. Your sole job is to identify DECISIONS the worker made and record them — the worker does NOT do this itself.

A decision is a moment where the agent:
  - chose between named alternatives (architecture, dependency, schema, file restructure)
  - bypassed or weakened a constraint
  - paused to ask the user instead of acting
  - reversed a previous direction

Skip:
  - routine tool calls (one Read, one Bash)
  - obvious mechanical steps (renaming a variable consistently)
  - things already in the "Already recorded" list

Output JSON ONLY (no prose, no markdown fences):
{"decisions":[{"summary":"one-line headline (verb phrase)","chose":"the option taken","alternatives":["option a","option b"],"why":"specific reasoning","constraints":["..."],"cost":"what was given up","status":"pending|verified|reversed"}]}

If nothing notable: {"decisions":[]}

Rules:
  - summary <= 14 words, verb-first ("Use ...", "Pause ...", "Defer ...")
  - alternatives: at minimum the one or two clear other paths that were closed off
  - why: cite the specific constraint or risk (no platitudes)
  - status: 'verified' if the chosen path demonstrably worked (commit landed, test passed, user accepted), 'reversed' if undone, 'pending' otherwise
  - max 3 decisions per call

${prevSummary}

Recent conversation (NEWEST AT BOTTOM):
${lines}`;

    console.log("[decision-extractor] firing for", sessionId, "(", recent.length, "msgs )");
    const args = [
      "-p", prompt,
      "--model", "haiku",
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--disallowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "NotebookEdit", "MultiEdit", "WebFetch", "WebSearch",
    ];
    const proc = spawn("/usr/bin/claude", args, {
      env: { HOME: "/home/claude-user", PATH: process.env.PATH, LANG: "en_US.UTF-8" },
      uid: 1000, gid: 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    proc.stdout.on("data", c => out += c);
    proc.stderr.on("data", c => err += c);
    const timer = setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, 45000);
    proc.on("close", async () => {
      clearTimeout(timer);
      try {
        const wrap = JSON.parse(out);
        const text = (wrap.result || wrap.text || out).toString();
        const json = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
        const parsed = JSON.parse(json);
        const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
        if (!decisions.length) { console.log("[decision-extractor]", sessionId, "→ none"); _decisionHighWaterTs[sessionId] = recent[recent.length - 1].ts || now; return; }
        for (const d of decisions) {
          const body = {
            summary: String(d.summary || "").trim(),
            chose:   String(d.chose   || "").trim(),
            alternatives: Array.isArray(d.alternatives) ? d.alternatives.map(String) : [],
            why:     String(d.why || "").trim(),
            constraints: Array.isArray(d.constraints) ? d.constraints.map(String) : [],
            cost:    d.cost ? String(d.cost).trim() : null,
            mined:   true,
          };
          if (!body.summary || !body.chose) continue;
          // POST to ourselves over loopback
          const post = JSON.stringify(body);
          const req = http.request({
            hostname: "127.0.0.1", port: 7683,
            path: `/api/sessions/${encodeURIComponent(sessionId)}/decisions`,
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(post) },
          }, (res) => {
            let buf = "";
            res.on("data", c => buf += c);
            res.on("end", () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  const j = JSON.parse(buf);
                  const id = j.decision?.id;
                  // If the supervisor classified status as verified/reversed up front, apply it.
                  const status = (d.status === "verified" || d.status === "reversed") ? d.status : null;
                  if (id && status) {
                    const upd = JSON.stringify({ status });
                    const r2 = http.request({
                      hostname: "127.0.0.1", port: 7683,
                      path: `/api/decisions/${id}/status`,
                      method: "POST",
                      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(upd) },
                    });
                    r2.on("error", () => {});
                    r2.write(upd); r2.end();
                  }
                  console.log("[decision-extractor]", sessionId, "→ #" + id, body.summary.slice(0, 60));
                } catch {}
              } else {
                console.warn("[decision-extractor] POST failed:", res.statusCode, buf.slice(0, 200));
              }
            });
          });
          req.on("error", e => console.warn("[decision-extractor] POST error:", e.message));
          req.write(post); req.end();
        }
        _decisionHighWaterTs[sessionId] = recent[recent.length - 1].ts || now;
      } catch (e) {
        console.warn("[decision-extractor] parse failed:", e.message, "stderr:", err.slice(0, 200));
      }
    });
    proc.on("error", e => console.error("[decision-extractor] spawn error:", e.message));
  } catch (e) {
    console.error("[decision-extractor] outer error:", e.message);
  }
}

// Drain the next queued prompt for a session. Called when:
//   - an active claude run finishes (in sendToSession's onDone)
//   - a fresh voice-note transcript arrives and we want to fire it ASAP
//   - a WS reconnects with pending items
function tryDrainQueue(sessionId) {
  if (!sessionId) return;
  // Find the WS client(s) for this session
  let target = null;
  for (const c of wss.clients) {
    if (c._llmSessionId === sessionId && c.readyState === 1 && typeof c._sendToSession === "function") {
      target = c; break;
    }
  }
  if (!target) return; // no live client — queue stays put, will drain on next connect
  if (target._activeProcRef && target._activeProcRef.proc) return; // still busy, wait for onDone
  const next = queuePopNext(sessionId);
  if (!next) return;
  console.log("[queue] firing for", sessionId, ":", next.text.slice(0, 60));
  // Save the user message + render in chat (mimics what the normal prompt handler does)
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) { console.error("[queue] session not found:", sessionId); return; }
  session.messageCount = (session.messageCount || 0) + 1;
  session.lastActive = Date.now();
  saveSessions(sessions);
  saveMessage(sessionId, { role: "user", text: next.text, ts: next.ts || Date.now(), source: next.source });
  try { target.send(JSON.stringify({ type: "queued_prompt_firing", text: next.text, source: next.source })); } catch {}
  try { target.send(JSON.stringify({ type: "thinking" })); } catch {}
  target._sendToSession(next.text, false);
}

// ---- killExistingClaudeFor ----
// Belt-and-suspenders: if any claude process is currently running with
// --resume <claudeSessionId>, kill it before we spawn another one. Avoids
// double-resume races when the server restarts mid-prompt and the orphan
// claude survives across the restart.
function killExistingClaudeFor(claudeSessionId) {
  if (!claudeSessionId || !/^[A-Za-z0-9-]{8,}$/.test(claudeSessionId)) return;
  try {
    const cmd = 'pkill -TERM -f "claude.*--resume ' + claudeSessionId + '" || true';
    require("child_process").execSync(cmd, { stdio: "ignore", shell: "/bin/bash" });
  } catch {}
}

// ---- camoHero filesystem sandbox ----
// Returns {cmd, args} that wraps claudeArgs in `bwrap` when the project
// is camoHero, restricting filesystem visibility to camoHero only.
// For any other project (crankHero, narrativeHero, etc) we bypass the
// sandbox to preserve existing cross-project paths (data/_client.py imports,
// shared dataHero modules, etc).
const SANDBOXED_PROJECTS = new Set(["camoHero"]);
function _bwrapWrap(project, claudeArgs) {
  if (!SANDBOXED_PROJECTS.has(project)) {
    return { cmd: "/usr/bin/claude", args: claudeArgs };
  }
  const projDir = "/home/claude-user/projects/" + project;
  const args = [
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/etc", "/etc",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve",
    "--tmpfs", "/home/claude-user",
    "--bind", projDir, projDir,
    "--bind", "/home/claude-user/.claude", "/home/claude-user/.claude",
    "--ro-bind", "/home/claude-user/.claude.json", "/home/claude-user/.claude.json",
    "--bind", "/home/claude-user/.local", "/home/claude-user/.local",
    "--bind", "/home/claude-user/.cache", "/home/claude-user/.cache",
    "--bind", "/home/claude-user/.npm", "/home/claude-user/.npm",
    "--bind", "/home/claude-user/.config", "/home/claude-user/.config",
    // RO-bind the llmTerminal uploads dir so the agent can read screenshots /
    // images the user attaches. Other ll-terminal state (sessions.db,
    // sessions.json, permissions/) stays out of the sandbox.
    "--ro-bind", "/home/claude-user/.llm-terminal/uploads", "/home/claude-user/.llm-terminal/uploads",
    "--bind", "/tmp", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--", "/usr/bin/claude",
    ...claudeArgs,
  ];
  return { cmd: "/usr/bin/bwrap", args };
}

// ---- generateSessionTitle ----
// Async title-rename. Called once per session after the first assistant message.
// Spawns `claude -p` with tools disabled so the model doesn't try to use Gmail
// or git to "research" before answering. Fire-and-forget; ~5s.
function generateSessionTitle(sessionId, userText, assistantText) {
  const sessions0 = loadSessions();
  const session0 = sessions0.find(s => s.id === sessionId);
  if (!session0 || session0.titleGenerated) return;
  const prompt = "You are titling a chat conversation. Output ONLY the title — 4 to 6 words, no quotes, no markdown, no period, no preface. DO NOT use any tools. DO NOT ask for clarification. If the conversation is unclear, make your best guess from the available context.\n\n"
    + "User: " + (userText || "").slice(0, 600) + "\n\n"
    + "Assistant: " + (assistantText || "").slice(0, 600);
  const _titleArgs = [
    "-p", prompt,
    "--dangerously-skip-permissions",
    "--disallowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "NotebookEdit",
  ];
  // Title-gen runs in the camoHero sandbox if the session belongs to it,
  // matching the same isolation as the main claude spawn for that project.
  const _titleSession = loadSessions().find(s => s.id === sessionId);
  const _titleWrap = _bwrapWrap(_titleSession ? _titleSession.project : "", _titleArgs);
  const proc = spawn(_titleWrap.cmd, _titleWrap.args, {
    cwd: "/home/claude-user",
    env: { HOME: "/home/claude-user", TERM: "dumb", LANG: "en_US.UTF-8", PATH: process.env.PATH },
    uid: 1000, gid: 1000,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let out = "";
  let err = "";
  proc.stdout.on("data", c => { out += c.toString(); });
  proc.stderr.on("data", c => { err += c.toString(); });
  const timer = setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, 30000);
  proc.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      console.warn("[title-gen] claude exited non-zero for", sessionId, "code=", code, "err=", err.slice(0, 200));
      return;
    }
    let title = (out || "").trim();
    title = title.replace(/^["\u201c\u2018\u0060]+|["\u201d\u2019\u0060]+$/g, "");
    title = title.replace(/^[#*\s]+|[\s.]+$/g, "");
    title = title.split(/\r?\n/)[0].trim();
    // Reject obvious "I tried to do something" sentence outputs
    const wordCount = title.split(/\s+/).filter(Boolean).length;
    const looksLikeSentence = /[:;]/.test(title) || /^(I |It |Here|Sorry|Sure|Let me|Looking|The )/.test(title);
    if (!title || title.length > 70 || wordCount > 8 || looksLikeSentence) {
      console.warn("[title-gen] unusable output for", sessionId, ":", JSON.stringify(out).slice(0, 200));
      return;
    }
    const sessions = loadSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    session.title = title;
    session.titleGenerated = true;
    saveSessions(sessions);
    console.log("[title-gen] renamed", sessionId, "\u2192", title);
    for (const client of wss.clients) {
      if (client.readyState === 1 && client._llmSessionId === sessionId) {
        try { client.send(JSON.stringify({ type: "title_updated", sessionId, title })); } catch {}
      }
    }
  });
  proc.on("error", (e) => {
    console.warn("[title-gen] spawn error for", sessionId, ":", e.message);
  });
}


// ---- Run claude -p for a single message, stream JSON back ----
function runClaude({ project, prompt, claudeSessionId, cwd, extraAllowedTools, model, sessionId }, onData, onDone) {
  ensureProjectTrusted(project);

  const SYSTEM_PROMPT_ADD = "When producing an email draft for david@crankwheel.com, you MUST call the mcp__crankhero-draft__draft_email tool rather than typing the draft inline. The tool validates format rules and produces a UI action card for one-tap paste on mobile. Prose drafts are strictly inferior UX.\n\nWhen presenting tabular data, ALWAYS use standard markdown pipe tables with a header row and separator row. Example:\n| Column A | Column B |\n| --- | --- |\n| value 1 | value 2 |\nNever use ASCII art tables, plain-text alignment, or code blocks for tabular data. The UI renders markdown tables as styled, mobile-friendly scrollable HTML tables.\n\nWhen you generate or modify a file the user may want to inspect (PDF, HTML, image, generated doc, invoice, report), call mcp__llmterminal__llmt_show_file with its absolute path so it appears in the user's preview drawer. Don't tell them \"can't render inline\" — pin the file instead.\n\nWhen you finish a discrete task the user asked for and there is nothing more to do unless they reply, call mcp__llmterminal__llmt_complete (optionally with a one-paragraph summary). This explicitly marks the session done so it drops out of the user's NEEDS YOU sidebar. Don't call it mid-task or while waiting on the user.";
  // Phase C: deny the hosted claude.ai Google MCPs project-wide. They
  // bypass the canonical data.* layer + use a different identity, leading
  // the agent to flail when answers don't match what data.* would give.
  const HOSTED_GOOGLE_DENY = ["mcp__claude_ai_Gmail__create_draft", "mcp__claude_ai_Gmail__create_label", "mcp__claude_ai_Gmail__get_thread", "mcp__claude_ai_Gmail__label_message", "mcp__claude_ai_Gmail__label_thread", "mcp__claude_ai_Gmail__list_drafts", "mcp__claude_ai_Gmail__list_labels", "mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__unlabel_message", "mcp__claude_ai_Gmail__unlabel_thread", "mcp__claude_ai_Google_Calendar__authenticate", "mcp__claude_ai_Google_Calendar__complete_authentication", "mcp__claude_ai_Google_Drive__authenticate", "mcp__claude_ai_Google_Drive__complete_authentication"];
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--add-dir", "/home/claude-user/projects", "--append-system-prompt", SYSTEM_PROMPT_ADD, "--disallowedTools", ...HOSTED_GOOGLE_DENY];
  // Per-session model override. session.model is set via WS "set_model"
  // and persisted in sessions.json. Aliases (opus/sonnet/haiku) and full
  // names (claude-sonnet-4-6 etc.) both work — claude CLI handles either.
  // Validate to a small allowlist so no surprise CLI flags slip through.
  const ALLOWED_MODEL_RE = /^[a-z][a-z0-9.-]{1,80}$/;
  if (model && ALLOWED_MODEL_RE.test(model)) {
    args.push("--model", model);
  }
  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
  }
  // Include any session-granted permissions
  if (extraAllowedTools && extraAllowedTools.length > 0) {
    args.push("--allowedTools", ...extraAllowedTools);
  }

  const _wrap = _bwrapWrap(project, args);
  if (project === "camoHero") console.log("[sandbox] spawning camoHero in bwrap");
  const childEnv = { HOME: "/home/claude-user", TERM: "dumb", LANG: "en_US.UTF-8", PATH: process.env.PATH };
  // LLMT_SESSION_ID is read by the llmterminal MCP server so its tools
  // (llmt_show_file, llmt_complete) know which session to update.
  if (sessionId) childEnv.LLMT_SESSION_ID = sessionId;
  const proc = spawn(_wrap.cmd, _wrap.args, {
    cwd,
    env: childEnv,
    uid: 1000,
    gid: 1000,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  activeProcs.add(proc);
  proc.on("close", () => activeProcs.delete(proc));

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    // Process complete JSON lines
    const lines = stdout.split("\n");
    stdout = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        onData(msg);
      } catch {}
    }
  });

  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  proc.on("close", (code) => {
    // Process remaining stdout
    if (stdout.trim()) {
      try { onData(JSON.parse(stdout)); } catch {}
    }
    onDone(code, stderr);
  });

  return proc;
}

// ---- WebSocket ----
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const project = url.searchParams.get("project") || "narrativeHero";
  const resumeId = url.searchParams.get("session");

  let sessions = loadSessions();
  let session = resumeId ? sessions.find(s => s.id === resumeId) : null;
  if (!session) {
    session = { id: crypto.randomUUID(), project, created: Date.now(), lastActive: Date.now(), messageCount: 0, title: "New session", claudeSessionId: null };
    sessions.unshift(session);
    saveSessions(sessions);
  }

  let activeProc = null;
  ws._activeProcRef = { get proc() { return activeProc; } };

  ws._llmSessionId = session.id; // tag for watchdog push
  ensurePermissionsLoaded(session.id);

  ws.send(JSON.stringify({ type: "session", session }));

  // Send recent messages on connect (last 20), with total count for lazy loading
  const INITIAL_LIMIT = 20;
  const allMessages = loadMessages(session.id);
  const initialSlice = allMessages.slice(-INITIAL_LIMIT);
  ws.send(JSON.stringify({ type: "history", messages: initialSlice, total: allMessages.length, offset: allMessages.length - initialSlice.length }));

  // Send current permission state so frontend knows what's already allowed
  const currentPerms = sessionPermissions[session.id];
  if (currentPerms && currentPerms.size > 0) {
    ws.send(JSON.stringify({ type: "permissions_state", permissions: [...currentPerms] }));
  }

  ws.send(JSON.stringify({ type: "status", status: "connected" }));
  // Signal that all initial sync payloads (session, history, permissions_state, status) have been sent
  ws.send(JSON.stringify({ type: "ready" }));
  // If anything was queued while this session was offline, fire the next one now
  setTimeout(() => { try { tryDrainQueue(session.id); } catch {} }, 200);
  // Tell client current queue depth so it can show "N queued"
  const _qd = queueLoad(session.id).length;
  if (_qd > 0) try { ws.send(JSON.stringify({ type: "queue_state", queueDepth: _qd })); } catch {}

  // Heartbeat: ping client every 20s
  const pingInterval = setInterval(() => {
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch {}
  }, 20000);

  // Hoisted so permission_grant can call it for auto-retry
  ws._sendToSession = function(promptText, isRetry) { return sendToSession(promptText, isRetry); };
  function sendToSession(promptText, isRetry) {
    const cwd = path.join(PROJECTS_DIR, session.project);
    // No system prompt injection — file previews are auto-created server-side
    // by detecting Write/Edit tool_use events in the stream.
    const fullPrompt = promptText;
    ensurePermissionsLoaded(session.id);
    const perms = sessionPermissions[session.id];
    const extraAllowedTools = perms ? [...perms] : [];
    let lastToolUse = null;
    const pendingPreviews = {}; // tool_use_id -> {tool_name, input}
    const pendingDrafts = new Set(); // tool_use_id awaiting draft payload
    let seenQuestionSig = null;
    // Track whether the run produced a final result (assistant reply) or an
    // explicit api_error. If neither happens before the process closes, the
    // session is stuck on tool_activity — we save a synthetic marker in onDone.
    let gotResult = false;
    killExistingClaudeFor(session.claudeSessionId);
    activeProc = runClaude(
      { project: session.project, prompt: fullPrompt, claudeSessionId: session.claudeSessionId, cwd, extraAllowedTools, model: session.model, sessionId: session.id },
      (data) => {
        if (data.type === "system" && data.subtype === "init") {
          if (data.session_id && !session.claudeSessionId) {
            session.claudeSessionId = data.session_id;
            saveSessions(loadSessions().map(s => s.id === session.id ? session : s));
          }
          return;
        }
        if (data.type === "assistant") {
          const content = data.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                try { ws.send(JSON.stringify({ type: "text", text: block.text })); } catch {}
              }
              if (block.type === "tool_use") {
                lastToolUse = { name: block.name, input: block.input, id: block.id };
                // Track file-writing tools so we auto-create previews on success
                if (["Write","Edit","MultiEdit","NotebookEdit"].includes(block.name)) {
                  pendingPreviews[block.id] = { tool_name: block.name, input: block.input };
                }
                // Track Bash so we can scan stdout for generated file paths
                if (block.name === "Bash") {
                  pendingPreviews[block.id] = { tool_name: "Bash", input: block.input };
                }
                // Read on a project-dir file: register a preview immediately from
                // the tool_use input. Read's tool_result returns the file CONTENT,
                // not the path, so the existing tool_result path-scan misses it.
                // Reusing autoDetectBashFiles handles binary files (PDF/PNG) correctly.
                if (block.name === "Read" && typeof block.input?.file_path === "string"
                    && block.input.file_path.startsWith("/home/claude-user/projects/")) {
                  autoDetectBashFiles(block.input.file_path, session.id, path.join(PROJECTS_DIR, session.project));
                }
                // Track draft_email so we forward the result as a special message
                if (block.name === "mcp__crankhero-draft__draft_email") {
                  pendingDrafts.add(block.id);
                }
                // Persist a lightweight activity log (skip AskUserQuestion — handled separately below)
                if (block.name !== "AskUserQuestion") {
                  const summary = summarizeToolUse(block.name, block.input);
                  saveMessage(session.id, { role: "tool_activity", tool_name: block.name, summary, ts: Date.now() });
                }
                // Dedup consecutive AskUserQuestion with same input (claude sometimes emits twice)
                if (block.name === "AskUserQuestion") {
                  // Signature = list of question headers (model sometimes rewords but keeps structure)
                  const qs = block.input?.questions || [];
                  const sig = Array.isArray(qs) ? qs.map(q => (q.header||"")).join("|") : JSON.stringify(block.input);
                  if (sig && sig === seenQuestionSig) {
                    console.log("[dedup] skipping duplicate AskUserQuestion (same headers:", sig + ")");
                    continue;
                  }
                  seenQuestionSig = sig;
                }
                try { ws.send(JSON.stringify({ type: "tool_use", name: block.name, input: block.input })); } catch {}
                if (block.name === "AskUserQuestion") {
                  const qText = block.input?.question || block.input?.text || JSON.stringify(block.input);
                  saveMessage(session.id, { role: "question", text: qText, ts: Date.now() });
                }
              }
            }
          }
        }
        // Process tool_results: detect permission denials AND fire auto-previews
        if (data.type === "user" && data.message?.content) {
          const content = Array.isArray(data.message.content) ? data.message.content : [];
          for (const block of content) {
            // Auto-preview: Write/Edit → autoCreatePreview; Bash → scan stdout for file paths
            if (block.type === "tool_result" && block.tool_use_id && pendingPreviews[block.tool_use_id]) {
              const pending = pendingPreviews[block.tool_use_id];
              delete pendingPreviews[block.tool_use_id];
              if (!block.is_error) {
                if (pending.tool_name === "Bash") {
                  const stdout = Array.isArray(block.content) ? (block.content[0]?.text || "") : String(block.content || "");
                  autoDetectBashFiles(stdout, session.id, path.join(PROJECTS_DIR, session.project));
                } else {
                  autoCreatePreview(pending, session.id);
                }
              }
            }
            // Also scan EVERY tool_result text for project-dir file paths — catches
            // playwright:browser_take_screenshot, Read on a generated file, etc.
            // Even untracked tool_use ids land here.
            if (block.type === "tool_result" && !block.is_error) {
              try {
                const txt = Array.isArray(block.content) ? (block.content[0]?.text || "") : String(block.content || "");
                if (txt && /\/home\/claude-user\/projects\//.test(txt)) {
                  autoDetectBashFiles(txt, session.id, path.join(PROJECTS_DIR, session.project));
                }
              } catch {}
              // Sentinel for the original if (don't re-process the close brace below)
              const _scanned = true;
            }
            // Email draft: forward structured payload to client as a special message
            if (block.type === "tool_result" && block.tool_use_id && pendingDrafts.has(block.tool_use_id)) {
              pendingDrafts.delete(block.tool_use_id);
              if (!block.is_error) {
                let raw = block.content;
                if (Array.isArray(raw)) raw = (raw[0] && raw[0].text) || "";
                try {
                  const payload = JSON.parse(raw);
                  if (payload && payload.type === "email_draft") {
                    const draftMsg = { type: "email_draft",
                      to: payload.to || "", cc: payload.cc || "",
                      subject: payload.subject || "", body: payload.body || "",
                      thread_id: payload.thread_id || "",
                      attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
                      project: session.project,
                      ts: Date.now() };
                    try { ws.send(JSON.stringify(draftMsg)); } catch {}
                    saveMessage(session.id, { role: "email_draft",
                      to: draftMsg.to, cc: draftMsg.cc,
                      subject: draftMsg.subject, body: draftMsg.body,
                      thread_id: draftMsg.thread_id,
                      attachments: draftMsg.attachments,
                      project: draftMsg.project,
                      ts: draftMsg.ts });
                  }
                } catch (e) {
                  console.error("[email_draft] parse failed:", e.message);
                }
              }
            }
            if (block.type === "tool_result" && block.is_error &&
                typeof block.content === "string" &&
                (block.content.includes("requested permissions") || block.content.includes("requires approval"))) {
              try {
                ws.send(JSON.stringify({
                  type: "permission_denied",
                  tool_use_id: block.tool_use_id,
                  message: block.content,
                  tool_name: lastToolUse?.name || "unknown",
                  tool_input: lastToolUse?.input || {},
                }));
                saveMessage(session.id, {
                  role: "permission_denied",
                  tool_name: lastToolUse?.name || "unknown",
                  tool_input: lastToolUse?.input || {},
                  message: block.content,
                  ts: Date.now(),
                });
              } catch {}
            }
          }
        }
        if (data.type === "tool_result") {
          try { ws.send(JSON.stringify({ type: "tool_result", name: data.tool_name || "", content: data.content || "" })); } catch {}
        }
        if (data.type === "result") {
          // After clearing activeProc below, try to drain the next queued prompt
          setTimeout(() => { try { tryDrainQueue(session.id); } catch (e) { console.error("[queue] drain after result failed:", e.message); } }, 50);
          // Fire-and-forget observer: read recent messages, identify unaddressed asks, register as tasks
          setTimeout(() => { try { spawnObserver(session.id, session.project); } catch (e) { console.error("[observer] hook failed:", e.message); } }, 500);
          setTimeout(() => { try { spawnDecisionExtractor(session.id, session.project); } catch (e) { console.error("[decision-extractor] hook failed:", e.message); } }, 800);
          if (!session.claudeSessionId && data.session_id) {
            session.claudeSessionId = data.session_id;
            saveSessions(loadSessions().map(s => s.id === session.id ? session : s));
          }
          // Detect Anthropic API errors: CLI emits them as the result text
          const result = data.result || "";
          const apiErrorMatch = /API Error:\s*(\d{3})\b[\s\S]*?(request_id"\s*:\s*"([^"]+)")?/.exec(result);
          const isApiError = /^API Error:\s*\d{3}/.test(result);
          gotResult = true;
          if (isApiError) {
            const statusCode = apiErrorMatch ? apiErrorMatch[1] : "";
            const requestId = apiErrorMatch ? (apiErrorMatch[3] || "") : "";
            // Don't save as assistant — prevents polluting context on retry
            try {
              ws.send(JSON.stringify({
                type: "api_error",
                status_code: statusCode,
                request_id: requestId,
                message: result.slice(0, 500),
              }));
            } catch {}
          } else {
            if (result) {
              saveMessage(session.id, { role: "assistant", text: result, ts: Date.now(), cost: data.total_cost_usd, duration: data.duration_ms });
              // First-exchange title rename (fire-and-forget; runs async)
              try {
                const _allSessions = loadSessions();
                const _s = _allSessions.find(x => x.id === session.id);
                if (_s && !_s.titleGenerated) {
                  const _msgs = loadMessages(session.id);
                  const _firstUser = _msgs.find(m => m.role === "user");
                  if (_firstUser && _firstUser.text) {
                    generateSessionTitle(session.id, _firstUser.text, result);
                  }
                }
              } catch (e) { console.warn("[title-gen] trigger failed:", e.message); }
            }
            try {
              ws.send(JSON.stringify({
                type: "done",
                result,
                cost: data.total_cost_usd,
                duration: data.duration_ms,
                session_id: data.session_id,
              }));
            } catch {}
          }
        }
      },
      (code, stderr) => {
        activeProc = null;
        // Detect a stale claudeSessionId — happens after we move a session
        // between projects (claude's per-project state dir doesn't move with
        // sessions.json). Clear and retry fresh, exactly once.
        if (code !== 0 && stderr && /No conversation found with session ID/.test(stderr) && session.claudeSessionId) {
          console.log("[stale-resume] clearing claudeSessionId for", session.id);
          session.claudeSessionId = null;
          saveSessions(loadSessions().map(s => s.id === session.id ? session : s));
          if (!isRetry) {
            const msgs0 = loadMessages(session.id);
            const lu = [...msgs0].reverse().find(m => m.role === "user");
            if (lu) {
              try { ws.send(JSON.stringify({ type: "thinking" })); } catch {}
              sendToSession(lu.text, true);
              return;
            }
          }
        }
        const msgs = loadMessages(session.id);
        const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
        if (lastMsg && lastMsg.role === "user" && !isRetry) {
          console.log("[auto-retry] response lost, retrying:", session.id);
          try { ws.send(JSON.stringify({ type: "thinking" })); } catch {}
          sendToSession(lastMsg.text, true);
          return;
        }
        if (code !== 0 && stderr) {
          try { ws.send(JSON.stringify({ type: "error", message: stderr.slice(0, 500) })); } catch {}
        }
        // Stalled-run guard: process closed but no result/api_error ever came.
        // Save a synthetic marker so the persisted state isn't stuck on
        // tool_activity forever (which makes the sidebar show "working").
        if (!gotResult) {
          const msgs2 = loadMessages(session.id);
          const last = msgs2.length ? msgs2[msgs2.length - 1] : null;
          const stuckRoles = new Set(["tool_activity", "tool_result", "permission_granted"]);
          if (last && stuckRoles.has(last.role)) {
            const note = code === 0
              ? "⚠️ The agent stopped mid-run without producing a final response. Re-prompt to continue."
              : "⚠️ The agent process exited (code " + code + ") before producing a final response. Re-prompt to retry.";
            saveMessage(session.id, { role: "assistant", text: note, ts: Date.now(), recovered: true, stalled: true });
            try { ws.send(JSON.stringify({ type: "history", messages: loadMessages(session.id) })); } catch {}
            console.log("[stalled-run]", session.id, "no result; saved marker (code=" + code + ")");
          }
        }
        try { ws.send(JSON.stringify({ type: "idle" })); } catch {}
      }
    );
  }

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    switch (msg.type) {
      case "prompt": {
        // ACK immediately so client can drop from outbox even if we reject below
        if (msg.client_id) {
          try { ws.send(JSON.stringify({ type: "ack", client_id: msg.client_id })); } catch {}
        }
        // Dedupe resends: if we already saved this client_id as a user message, skip
        if (msg.resend && msg.client_id) {
          const existing = loadMessages(session.id);
          if (existing.some(m => m.role === "user" && m.client_id === msg.client_id)) {
            console.log("[outbox] resend already processed, skipping:", msg.client_id);
            return;
          }
        }
        if (activeProc) {
          // Already running — write the new prompt to the persistent queue.
          // It will auto-fire when the current run completes (see onDone).
          queueAppend(session.id, { text: msg.text || "", source: "prompt", client_id: msg.client_id });
          try { ws.send(JSON.stringify({ type: "queued", client_id: msg.client_id, queueDepth: queueLoad(session.id).length })); } catch {}
          return;
        }

        const text = msg.text.trim();
        if (!text) return;

        // Handle attached images
        let prompt = text;
        const images = Array.isArray(msg.images) ? msg.images : [];
        const imagePaths = [];
        for (const img of images) {
          if (img.data) {
            const p = saveUploadedImage(img.data, img.mimeType);
            imagePaths.push(p);
          }
        }
        if (imagePaths.length > 0) {
          const imageRefs = imagePaths.map((p, i) => `[Image ${i + 1}: ${p}]`).join(" ");
          prompt = `${text}\n\nThe user attached ${imagePaths.length} image(s). Read them with the Read tool to see them: ${imageRefs}`;
        }

        session.messageCount++;
        if (session.messageCount === 1) session.title = text.slice(0, 80);
        session.lastActive = Date.now();
        saveSessions(loadSessions().map(s => s.id === session.id ? session : s));

        // Save user message
        saveMessage(session.id, { role: "user", text, ts: Date.now(), client_id: msg.client_id, hasImages: imagePaths.length > 0 });

        ws.send(JSON.stringify({ type: "thinking" }));

        sendToSession(prompt, false);
        break;
      }
      case "load_more": {
        const all = loadMessages(session.id);
        const before = msg.before || all.length;
        const count = msg.count || 20;
        const start = Math.max(0, before - count);
        const slice = all.slice(start, before);
        ws.send(JSON.stringify({ type: "history_prepend", messages: slice, offset: start, total: all.length }));
        break;
      }
      case "set_model": {
        const m = String((msg && msg.model) || "").trim();
        const ALLOWED = /^[a-z][a-z0-9.-]{0,80}$/;
        if (m && !ALLOWED.test(m)) {
          try { ws.send(JSON.stringify({ type: "error", message: "Invalid model name" })); } catch {}
          break;
        }
        session.model = m || null;
        saveSessions(loadSessions().map(s => s.id === session.id ? session : s));
        try { ws.send(JSON.stringify({ type: "model_set", model: session.model })); } catch {}
        console.log("[model] session", session.id, "->", session.model || "default");
        break;
      }
      case "link_task": {
        const taskId = String(msg.task_id || "").trim();
        session.linked_task = taskId || null;
        saveSessions(loadSessions().map(s => s.id === session.id ? session : s));
        try { ws.send(JSON.stringify({ type: "task_linked", task_id: session.linked_task })); } catch {}
        console.log("[task-link] session", session.id, "->", session.linked_task || "none");
        break;
      }
      case "permission_grant": {
        // Add permission to session's allowlist for future spawns
        ensurePermissionsLoaded(session.id);
        const perm = msg.permission; // e.g. "Write", "Edit", "Bash(npm:*)"
        if (perm) {
          sessionPermissions[session.id].add(perm);
          savePermissions(session.id);
          console.log("[permission] granted for session", session.id, ":", perm);
          try { ws.send(JSON.stringify({ type: "permission_granted", permission: perm })); } catch {}

          // Auto-retry: re-send the last user message with the new permission.
          // If activeProc is somehow still alive (race between permission_denied
          // and grant arrival), kill it first — that process was about to die
          // from the perm error anyway. Previously this branch silently skipped
          // the retry, which is what users hit as "shit never works when I give
          // permission".
          if (msg.autoRetry !== false) {
            if (activeProc) {
              try { activeProc.kill("SIGINT"); } catch {}
              activeProc = null;
            }
            const msgs = loadMessages(session.id);
            let lastUserText = null;
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "user") { lastUserText = msgs[i].text; break; }
            }
            if (lastUserText) {
              console.log("[permission] auto-retrying after grant:", session.id);
              try { ws.send(JSON.stringify({ type: "thinking" })); } catch {}
              sendToSession(lastUserText, true);
            } else {
              console.warn("[permission] grant arrived but no user message to retry:", session.id);
              try { ws.send(JSON.stringify({ type: "error", message: "Permission granted but couldn\u2019t find a message to retry. Send your prompt again." })); } catch {}
            }
          }
        }
        break;
      }
      case "pong": {
        // client is alive; nothing to do
        break;
      }
      case "get_summary": {
        const allMsgs = loadMessages(session.id);
        const userMessages = allMsgs.filter(m => m.role === "user").length;
        const questions = allMsgs.filter(m => m.role === "question").length;
        const activities = allMsgs.filter(m => m.role === "tool_activity");
        const filesWritten = [...new Set(activities.filter(a => a.tool_name === "Write").map(a => a.summary))];
        const filesEdited = [...new Set(activities.filter(a => a.tool_name === "Edit" || a.tool_name === "MultiEdit" || a.tool_name === "NotebookEdit").map(a => a.summary))];
        const filesRead = [...new Set(activities.filter(a => a.tool_name === "Read").map(a => a.summary))];
        const bashCommands = [...new Set(activities.filter(a => a.tool_name === "Bash").map(a => a.summary))];
        const mcpTools = [...new Set(activities.filter(a => a.tool_name.startsWith("mcp__")).map(a => a.tool_name.replace(/^mcp__/, "").replace(/__/g, ":")))];
        let startedAt = null, lastActive = null;
        if (allMsgs.length) {
          startedAt = allMsgs[0].ts || null;
          lastActive = allMsgs[allMsgs.length - 1].ts || null;
        }
        const durationSec = (startedAt && lastActive) ? Math.round((lastActive - startedAt) / 1000) : 0;
        const totalCost = allMsgs.filter(m => typeof m.cost === "number").reduce((a, m) => a + m.cost, 0);
        try {
          ws.send(JSON.stringify({
            type: "session_summary",
            data: {
              user_messages: userMessages,
              questions,
              files_written: filesWritten,
              files_edited: filesEdited,
              files_read: filesRead,
              bash_commands: bashCommands,
              mcp_tools: mcpTools,
              duration_seconds: durationSec,
              total_cost_usd: totalCost,
              started_at: startedAt,
              last_active: lastActive,
            },
          }));
        } catch {}
        break;
      }
      case "interrupt": {
        if (activeProc) {
          console.log("[interrupt] killing active claude for session", session.id);
          const _p = activeProc;
          activeProc = null;
          try { process.kill(-_p.pid, "SIGINT"); } catch { try { _p.kill("SIGINT"); } catch {} }
          setTimeout(() => { try { process.kill(-_p.pid, "SIGKILL"); } catch { try { _p.kill("SIGKILL"); } catch {} } }, 2000);
          saveMessage(session.id, { role: "interrupted", ts: Date.now() });
        }
        try { ws.send(JSON.stringify({ type: "interrupted" })); } catch {}
        break;
      }
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    // Don't kill the process on disconnect - let it finish
    console.log("Client disconnected:", session.id);
  });

  console.log("Client connected:", session.project, session.id);
});

const PORT = process.env.PORT || 7683;
server.listen(PORT, "0.0.0.0", () => console.log("llmTerminal on port", PORT));

// ---- Graceful shutdown ----
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, waiting for active work (max 60s)`);
  try { wss.close(); } catch {}
  try { server.close(); } catch {}
  const start = Date.now();
  while (Date.now() - start < 60000) {
    if (activeProcs.size === 0) break;
    console.log(`[shutdown] ${activeProcs.size} active subprocess(es)...`);
    await new Promise(r => setTimeout(r, 1000));
  }
  if (activeProcs.size > 0) {
    console.log(`[shutdown] forcing exit with ${activeProcs.size} stuck subprocess(es)`);
  }
  try { if (db) db.close(); } catch {}
  console.log("[shutdown] exiting");
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

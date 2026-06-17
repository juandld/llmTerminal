// Per-session prompt queue (file-backed JSONL) + queue-state broadcast.
// Extracted from server.js (refactor 2026-06-10, phase 6).
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");
const { broadcastToSession } = require("./ws/broadcast");

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
// Push the current queue contents (texts + client_ids) to every WS client on this
// session so the chat UI can render pending bubbles instead of just a depth count.
function broadcastQueueState(sessionId) {
  if (!sessionId) return;
  const items = queueLoad(sessionId).map(it => ({
    text: it.text || "",
    source: it.source || "prompt",
    client_id: it.client_id || null,
    ts: it.ts || null,
    audioUrl: it.audioUrl || null,
  }));
  broadcastToSession(sessionId, { type: "queue_state", queueDepth: items.length, items });
}

module.exports = { queueFile, queueAppend, queueLoad, queueSaveAll, queuePopNext, broadcastQueueState };

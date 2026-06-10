// WebSocket send/broadcast helpers + session-404 guard for llmTerminal.
// Extracted from server.js (refactor 2026-06-10, phase 5). broadcastToSession
// needs the Wss instance, injected once via setWss() at startup.
const { loadSessions } = require("../store");

let _wss = null;
function setWss(wss) { _wss = wss; }
function getWss() { return _wss; }

function wsSend(ws, typeOrPayload, data) {
  try {
    const payload = typeof typeOrPayload === "string"
      ? Object.assign({ type: typeOrPayload }, data || {})
      : typeOrPayload;
    ws.send(JSON.stringify(payload));
  } catch {}
}
// Look up a session by id, sending a 404 response if missing.
// Returns { sessions, session } or null (after responding with 404).
function findSessionOr404(id, res) {
  const sessions = loadSessions();
  const session = sessions.find(x => x.id === id);
  if (!session) { res.status(404).json({ ok: false, error: "not found" }); return null; }
  return { sessions, session };
}
// Push a JSON payload to all WS clients subscribed to a given session.
function broadcastToSession(sessionId, payload) {
  if (!_wss) return;
  const msg = JSON.stringify(payload);
  for (const client of _wss.clients) {
    if (client.readyState === 1 && client._llmSessionId === sessionId) {
      try { client.send(msg); } catch {}
    }
  }
}

module.exports = { setWss, getWss, wsSend, findSessionOr404, broadcastToSession };

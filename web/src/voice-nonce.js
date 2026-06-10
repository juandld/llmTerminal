// Voice-note capability nonces: short-lived tokens binding a voice upload to a
// live WS session. Extracted (refactor 2026-06-11).
const crypto = require("crypto");

// Map: nonce (32-hex string) -> { sessionId, ws, createdAt }
const voiceNonces = new Map();
const VOICE_NONCE_TTL_MS = 30 * 60 * 1000; // 30 min safety net; primary kill is ws.close

function issueVoiceNonce(sessionId, ws) {
  const nonce = crypto.randomBytes(16).toString("hex");
  voiceNonces.set(nonce, { sessionId, ws, createdAt: Date.now() });
  return nonce;
}

function resolveVoiceNonce(nonce) {
  if (!nonce) return null;
  const entry = voiceNonces.get(nonce);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > VOICE_NONCE_TTL_MS) {
    voiceNonces.delete(nonce);
    return null;
  }
  // WS may be readyState 1 (OPEN), 2 (CLOSING), or 3 (CLOSED). Only 1 is valid.
  if (entry.ws && entry.ws.readyState !== 1) {
    voiceNonces.delete(nonce);
    return null;
  }
  return entry;
}

function revokeNoncesForWs(ws) {
  for (const [k, v] of voiceNonces) {
    if (v.ws === ws) voiceNonces.delete(k);
  }
}

// Periodic sweep — defensive, in case a ws close handler ever fails to fire.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of voiceNonces) {
    if (now - v.createdAt > VOICE_NONCE_TTL_MS) voiceNonces.delete(k);
    else if (v.ws && v.ws.readyState !== 1) voiceNonces.delete(k);
  }
}, 5 * 60 * 1000).unref();

module.exports = { issueVoiceNonce, resolveVoiceNonce, revokeNoncesForWs, VOICE_NONCE_TTL_MS };

const crypto = require("crypto");
const fs = require("fs");
const express = require("express");

// ── In-browser Claude Code re-auth (direct OAuth code flow) ─────────────────
// When the Claude token expires (it's long-lived, ~months, but eventually
// dies), every chat 401s. This lets David re-auth from the phone: we run the
// standard OAuth authorization-code + PKCE flow OURSELVES — generate the
// verifier/challenge, hand back the authorize URL, and on code submission POST
// to claude.ai's token endpoint and write the credentials. Bonus over the CLI's
// `setup-token`: this returns a refresh token, so future expiries can auto-renew.
const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://claude.ai/v1/oauth/token",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  scope: "user:inference",
  credPath: "/home/claude-user/.claude/.credentials.json",
};
let _authFlow = null; // { verifier, state }

function _b64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function _readTokenExpiry() {
  try {
    const c = JSON.parse(fs.readFileSync(CLAUDE_OAUTH.credPath, "utf8"));
    const o = c.claudeAiOauth || {};
    return { expiresAt: o.expiresAt || 0, expired: !o.expiresAt || o.expiresAt <= Date.now(), hasRefresh: !!o.refreshToken };
  } catch { return { expiresAt: 0, expired: true, hasRefresh: false }; }
}

module.exports = function mountClaudeAuth(app) {
  app.get("/api/claude-auth/status", (_req, res) => { res.json(_readTokenExpiry()); });

  app.post("/api/claude-auth/start", express.json(), (req, res) => {
    try {
      const verifier = _b64url(crypto.randomBytes(32));
      const challenge = _b64url(crypto.createHash("sha256").update(verifier).digest());
      const state = _b64url(crypto.randomBytes(32));
      _authFlow = { verifier, state, startedAt: Date.now() };
      const u = new URL(CLAUDE_OAUTH.authorizeUrl);
      u.searchParams.set("code", "true");
      u.searchParams.set("client_id", CLAUDE_OAUTH.clientId);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("redirect_uri", CLAUDE_OAUTH.redirectUri);
      u.searchParams.set("scope", CLAUDE_OAUTH.scope);
      u.searchParams.set("code_challenge", challenge);
      u.searchParams.set("code_challenge_method", "S256");
      u.searchParams.set("state", state);
      res.json({ ok: true, url: u.toString() });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/claude-auth/submit", express.json(), async (req, res) => {
    let code = String((req.body && req.body.code) || "").trim();
    if (!_authFlow) return res.status(400).json({ ok: false, error: "no auth flow in progress — tap Begin again" });
    if (!code) return res.status(400).json({ ok: false, error: "no code provided" });
    // claude.ai hands back `<code>#<state>`. Split; tolerate a bare code too.
    let returnedState = _authFlow.state;
    if (code.includes("#")) { const parts = code.split("#"); code = parts[0]; returnedState = parts[1] || _authFlow.state; }
    try {
      const r = await fetch(CLAUDE_OAUTH.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          state: returnedState,
          client_id: CLAUDE_OAUTH.clientId,
          redirect_uri: CLAUDE_OAUTH.redirectUri,
          code_verifier: _authFlow.verifier,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.access_token) {
        console.log("[claude-auth] exchange failed HTTP " + r.status + " " + JSON.stringify(data).slice(0, 300));
        return res.status(400).json({ ok: false, error: (data.error_description || data.error || ("token endpoint HTTP " + r.status)) + " — re-run from Step 1 (codes are single-use)" });
      }
      // Preserve subscriptionType/rateLimitTier from the old creds if present.
      let prev = {};
      try { prev = (JSON.parse(fs.readFileSync(CLAUDE_OAUTH.credPath, "utf8")).claudeAiOauth) || {}; } catch {}
      const expiresAt = Date.now() + (Number(data.expires_in || 0) * 1000);
      const scopes = (data.scope ? String(data.scope).split(" ") : (prev.scopes || ["user:inference"]));
      const cred = { claudeAiOauth: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || prev.refreshToken || "",
        expiresAt,
        scopes,
        ...(prev.subscriptionType ? { subscriptionType: prev.subscriptionType } : {}),
        ...(prev.rateLimitTier ? { rateLimitTier: prev.rateLimitTier } : {}),
      }};
      fs.writeFileSync(CLAUDE_OAUTH.credPath, JSON.stringify(cred, null, 2), { mode: 0o600 });
      try { fs.chownSync(CLAUDE_OAUTH.credPath, 1000, 1000); } catch {}
      _authFlow = null;
      console.log("[claude-auth] SUCCESS exp=" + expiresAt + " hasRefresh=" + !!data.refresh_token);
      res.json({ ok: true, expiresAt, hasRefresh: !!data.refresh_token });
    } catch (e) {
      console.log("[claude-auth] submit error: " + e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};

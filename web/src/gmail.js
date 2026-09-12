// Gmail Pub/Sub push webhook + watch renewal. Extracted from server.js
// (refactor 2026-06-10, phase 9). Scripts live in ../scripts relative to this file.
const { spawn } = require("child_process");
const path = require("path");
const express = require("express");

module.exports = function mountGmail(app) {
  // ---- Gmail Pub/Sub Webhook (replaces 5-min polling timer) ----
  const GMAIL_POLLER_SCRIPT = path.join(__dirname, "..", "scripts", "gmail-reply-poller.py");
  // crankHero deal-activity fan-out: same push notification refreshes the
  // CRM pipeline card for whichever deal(s) the new message maps to.
  // Independent of the llmTerminal poller — they run in parallel.
  const CRANKHERO_CRM = "/home/claude-user/projects/crankHero/scripts/crm.py";
  let _gmailPollerRunning = false;
  let _crankheroPushRunning = false;

  app.post("/webhooks/gmail", express.json(), (req, res) => {
    // Google Pub/Sub push delivery format:
    // { message: { data: "<base64>", messageId, publishTime }, subscription }
    // data decodes to: { emailAddress, historyId }
    res.status(200).send(); // ack immediately to avoid redelivery

    const dataB64 = req.body?.message?.data;
    let emailAddress = "unknown";
    if (dataB64) {
      try {
        const decoded = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
        emailAddress = decoded.emailAddress || "unknown";
      } catch {}
    }
    console.log("[gmail-webhook] push notification for:", emailAddress);

    // Fan-out #1: llmTerminal chat-reactivation poller.
    if (!_gmailPollerRunning) {
      _gmailPollerRunning = true;
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
      setTimeout(() => { _gmailPollerRunning = false; }, 30000);
    }

    // Fan-out #2: crankHero CRM per-deal activity refresh. Envelope is
    // piped verbatim to `crm.py push-update` on stdin; the handler diffs
    // Gmail history from its own state and rewrites deal_activity.json
    // for whichever deals the new messages resolve to. Debounced separately.
    if (!_crankheroPushRunning) {
      _crankheroPushRunning = true;
      const chChild = spawn("python3", [CRANKHERO_CRM, "push-update"], {
        cwd: "/home/claude-user/projects/crankHero",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let chOut = "";
      chChild.stdout.on("data", d => { chOut += d; });
      chChild.stderr.on("data", d => { chOut += d; });
      chChild.on("close", (code) => {
        _crankheroPushRunning = false;
        if (chOut.trim()) console.log("[gmail-webhook] crankhero output:", chOut.trim());
        if (code !== 0) console.warn("[gmail-webhook] crankhero push-update exited with code:", code);
      });
      chChild.on("error", (e) => {
        _crankheroPushRunning = false;
        console.warn("[gmail-webhook] crankhero spawn error:", e.message);
      });
      try { chChild.stdin.end(JSON.stringify(req.body || {})); } catch {}
      setTimeout(() => { _crankheroPushRunning = false; }, 60000);
    }
  });

  // Watch renewal: call users.watch() on startup and every 6 days
  const GMAIL_SETUP_SCRIPT = path.join(__dirname, "..", "scripts", "gmail-pubsub-setup.py");
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
};

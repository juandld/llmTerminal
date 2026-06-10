// Gmail Pub/Sub push webhook + watch renewal. Extracted from server.js
// (refactor 2026-06-10, phase 9). Scripts live in ../scripts relative to this file.
const { spawn } = require("child_process");
const path = require("path");
const express = require("express");

module.exports = function mountGmail(app) {
  // ---- Gmail Pub/Sub Webhook (replaces 5-min polling timer) ----
  const GMAIL_POLLER_SCRIPT = path.join(__dirname, "..", "scripts", "gmail-reply-poller.py");
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

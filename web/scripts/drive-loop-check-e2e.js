#!/usr/bin/env node
// drive-loop-check-e2e.js — one-shot driver for a REAL production post-fix
// verification cycle (not a unit test): opens a genuine WS session against
// the live llmTerminal server exactly like a browser would, sends a prompt
// that dispatches a real orchestrator queue item and then yields the turn
// with ping-me language, and prints the session id + client_id so the
// caller can watch journalctl / poll the transcript for the rest of the
// cycle (loop-check fires -> wake arms -> wake fires -> session resumes
// headlessly -> follow-up message lands).
//
// Run: node web/scripts/drive-loop-check-e2e.js
const WebSocket = require("ws");
const crypto = require("crypto");

const ws = new WebSocket("ws://localhost:7683/ws?project=orchestratorHero");
const clientId = "e2e-loopcheck-" + crypto.randomBytes(4).toString("hex");

ws.on("open", () => console.log("[driver] connected"));
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "session") {
    console.log("SESSION_ID=" + msg.session.id);
    const marker = "loop-check-e2e-" + Date.now();
    const finalPrompt =
      "This is a real production verification run of the orchestrator loop-continuation fix — do these actions for real, don't simulate or describe them.\n\n" +
      "Do exactly these two things, in order, in this ONE turn:\n" +
      "1. Dispatch a real, tiny orchestrator queue item with a single curl call to " +
      "http://localhost:8000/api/orchestrator/queue/create (Content-Type: application/json), JSON body with these fields: " +
      `title="loop-check e2e verification", description="Append the exact line '${marker}' to development/loop_check_verification_log.md (create the file with just that one line if it does not exist yet). Verify with: grep -F '${marker}' development/loop_check_verification_log.md", ` +
      `priority="normal", origin_session="${msg.session.id}". ` +
      "Construct valid JSON yourself (mind the quoting). Do NOT poll or wait for the task to finish — just fire the curl once and read the task_id back from the response.\n" +
      "2. Then IMMEDIATELY end your turn with a reply along the lines of: \"Queue task dispatched — I'll surface the result when it lands, ping me for status any time.\" Do not do anything else after that. This exact yield phrasing is intentional and is the anti-pattern under test.";
    console.log("CLIENT_ID=" + clientId);
    ws.send(JSON.stringify({ type: "prompt", text: finalPrompt, client_id: clientId, source: "prompt" }));
  }
  if (msg.type === "result" || (msg.type === "history" && msg.messages && msg.messages.some(m => m.client_id === clientId))) {
    // Turn is underway/complete server-side; safe to disconnect like a closed tab.
  }
  if (msg.type === "ready") {
    // initial sync done
  }
});
ws.on("error", (e) => { console.error("[driver] ws error:", e.message); process.exit(1); });

// Give the prompt time to be accepted + the run to start server-side, then
// disconnect (production-equivalent of closing the browser tab — the run
// keeps going per ws/connection.js "Don't kill the process on disconnect").
setTimeout(() => { console.log("[driver] disconnecting (run continues server-side)"); ws.close(); process.exit(0); }, 15000);

#!/usr/bin/env node
// Supervisor sweep: reads recent session activity and updates the orchestrator task board.
// Run via cron every 10-15 minutes: */10 * * * * node /home/claude-user/projects/llmTerminal/web/scripts/supervisor-sweep.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = "/home/claude-user/.llm-terminal";
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const MESSAGES_DB = path.join(DATA_DIR, "messages.db");
const SWEEP_STATE_FILE = path.join(DATA_DIR, "supervisor-sweep-state.json");
const ORCH_BASE = "http://localhost:8000/api/orchestrator";

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch { return []; }
}

function loadSweepState() {
  try { return JSON.parse(fs.readFileSync(SWEEP_STATE_FILE, "utf8")); } catch { return {}; }
}

function saveSweepState(state) {
  fs.writeFileSync(SWEEP_STATE_FILE, JSON.stringify(state, null, 2));
}

function loadRecentMessages(sessionId, afterTs) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(MESSAGES_DB, { readOnly: true });
    const stmt = db.prepare("SELECT role, text, ts FROM messages WHERE session_id = ? AND ts > ? ORDER BY ts ASC LIMIT 50");
    const rows = stmt.all(sessionId, afterTs);
    db.close();
    return rows;
  } catch (e) {
    console.warn("[sweep] sqlite read failed:", e.message);
    return [];
  }
}

async function summarizeSession(messages, taskTitle) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { console.error("[sweep] OPENAI_API_KEY not set"); return null; }

  const transcript = messages.map(m => `[${m.role}] ${(m.text || "").slice(0, 300)}`).join("\n");
  if (transcript.length < 50) return null;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 200,
      messages: [
        { role: "system", content: `You are a project supervisor observing a terminal session linked to task: "${taskTitle}". Based on the recent messages, provide:
1. A 1-2 sentence summary of what was accomplished
2. Current status: one of "in_progress", "blocked", "review", "merged", "closed"
3. If blocked, the reason why
Respond as JSON: {"summary":"...","status":"...","blocked_reason":"..."}` },
        { role: "user", content: transcript.slice(0, 4000) }
      ]
    })
  });
  if (!r.ok) { console.warn("[sweep] openai error:", r.status); return null; }
  const data = await r.json();
  const content = (data.choices?.[0]?.message?.content || "").trim();
  try { return JSON.parse(content); } catch { return null; }
}

async function postTaskComment(taskId, message) {
  try {
    const r = await fetch(ORCH_BASE + "/queue/items/" + taskId + "/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "[Supervisor] " + message })
    });
    return r.ok;
  } catch { return false; }
}

async function transitionTask(taskId, status, detail) {
  try {
    const body = { status };
    if (detail) body.detail = detail;
    if (status === "blocked" && detail) body.blocked_reason = detail;
    const r = await fetch(ORCH_BASE + "/queue/items/" + taskId + "/transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return r.ok;
  } catch { return false; }
}

async function retitleSession(sessionId, currentTitle) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  // Load last 10 user messages to capture how the chat has morphed
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(MESSAGES_DB, { readOnly: true });
    const rows = db.prepare(
      "SELECT role, text FROM messages WHERE session_id = ? AND role = 'user' ORDER BY ts DESC LIMIT 10"
    ).all(sessionId);
    db.close();
    if (rows.length < 2) return null;

    // Reverse so chronological, take first 200 chars each
    const transcript = rows.reverse().map(r => (r.text || "").slice(0, 200)).join("\n---\n");
    if (transcript.length < 30) return null;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 30,
        messages: [
          { role: "system", content: `You re-title chat sessions that have evolved over time. The current title is: "${currentTitle}". Based on the user's recent messages below, output a NEW title that reflects what the conversation is CURRENTLY about — not what it started as. Rules: 4-6 words, no quotes, no markdown, no period, no preface. Output ONLY the title.` },
          { role: "user", content: transcript.slice(0, 3000) }
        ]
      })
    });
    if (!r.ok) return null;
    const data = await r.json();
    let title = (data.choices?.[0]?.message?.content || "").trim();
    title = title.replace(/^["\u201c\u2018\u0060]+|["\u201d\u2019\u0060]+$/g, "");
    title = title.replace(/^[#*\s]+|[\s.]+$/g, "");
    title = title.split(/\r?\n/)[0].trim();
    const wordCount = title.split(/\s+/).filter(Boolean).length;
    if (!title || title.length > 70 || wordCount > 8) return null;
    // Don't update if title is basically the same
    if (title.toLowerCase() === (currentTitle || "").toLowerCase()) return null;
    return title;
  } catch (e) {
    console.warn("[sweep] retitle failed for", sessionId, ":", e.message);
    return null;
  }
}

async function main() {
  console.log("[sweep] starting supervisor sweep...");
  const sessions = loadSessions();
  const state = loadSweepState();
  let updated = 0;

  // ── Title drift: re-title sessions every 10 messages ──
  let titlesUpdated = 0;
  const activeSessions = sessions.filter(s =>
    !s.archived && !s.manualDone && s.titleGenerated && (s.messageCount || 0) >= 10
  );
  for (const s of activeSessions) {
    const lastTitleAt = state[`title:${s.id}`] || 0;
    // Re-title every 10 messages since last title update
    if ((s.messageCount || 0) - lastTitleAt < 10) continue;

    const newTitle = await retitleSession(s.id, s.title);
    if (newTitle) {
      s.title = newTitle;
      state[`title:${s.id}`] = s.messageCount;
      titlesUpdated++;
      console.log(`[sweep] retitled ${s.id}: "${newTitle}" (at msg ${s.messageCount})`);
    } else {
      // Mark checked so we don't retry every sweep
      state[`title:${s.id}`] = s.messageCount;
    }
  }
  if (titlesUpdated) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
    console.log(`[sweep] ${titlesUpdated} sessions retitled`);
  }

  // Only look at sessions with a linked task
  const linked = sessions.filter(s => s.linked_task);
  console.log(`[sweep] ${linked.length} sessions linked to tasks`);

  for (const s of linked) {
    const lastCheck = state[s.id] || 0;
    const messages = loadRecentMessages(s.id, lastCheck);
    if (messages.length < 2) continue; // not enough new activity

    console.log(`[sweep] session ${s.id} (task ${s.linked_task}): ${messages.length} new messages`);

    const result = await summarizeSession(messages, s.title || "untitled");
    if (!result) continue;

    // Post summary as comment
    await postTaskComment(s.linked_task, result.summary);

    // Transition if status changed
    if (result.status && result.status !== "in_progress") {
      const ok = await transitionTask(s.linked_task, result.status, result.blocked_reason || result.summary);
      if (ok) console.log(`[sweep] task ${s.linked_task} -> ${result.status}`);
    }

    // Update sweep state
    state[s.id] = Date.now();
    updated++;
  }

  saveSweepState(state);

  // ── Email verification: cross-reference email_draft sessions with sent log ──
  const SENT_LOG = "/home/claude-user/projects/dataHero/.credentials/gmail_sent_log.jsonl";
  try {
    const emailSessions = sessions.filter(s => !s.manualDone && s.lastMessageRole === "email_draft");
    if (emailSessions.length) {
      // Load sent log entries from last 7 days
      const sentEntries = [];
      try {
        const lines = fs.readFileSync(SENT_LOG, "utf8").trim().split("\n");
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            if (new Date(e.sent_at).getTime() > cutoff) sentEntries.push(e);
          } catch {}
        }
      } catch {}

      let emailsDone = 0;
      for (const s of emailSessions) {
        // Match by sessionId or by subject in session title
        const match = sentEntries.find(e =>
          (e.sessionId && e.sessionId === s.id) ||
          (s.title && e.subject && s.title.toLowerCase().includes(e.subject.toLowerCase().slice(0, 30)))
        );
        if (match) {
          s.emailOpened = match.sent_at;
          s.manualDone = Date.now();
          emailsDone++;
          console.log(`[sweep] email verified sent: "${s.title}" -> done (matched: ${match.subject})`);
        }
      }
      if (emailsDone) {
        // Save updated sessions
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
        console.log(`[sweep] ${emailsDone} email sessions auto-marked done`);
      }
    }
  } catch (e) { console.warn("[sweep] email check failed:", e.message); }

  console.log(`[sweep] done. ${updated} tasks updated.`);
}

main().catch(e => { console.error("[sweep] fatal:", e); process.exit(1); });

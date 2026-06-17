// Cheap/background model calls (Haiku CLI + OpenAI) used by supervisors,
// title-gen, classify, and ROI scoring. Extracted (refactor 2026-06-10).
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");
const throttle = require("./throttle");

// Per-hero context chunks parsed from ~/.claude/CLAUDE.md. Each row in the
// "project table" is one hero's blurb. Cheap-claude spawns auto-load the full
// CLAUDE.md by default — that's how Mandarin/langHero leaked onto a
// crankHero voiceover chat (title-gen bug, 2026-06-17). Passing
// --system-prompt with JUST this hero's row keeps the cheap agent scoped to
// the relevant context without dragging the rest of the ecosystem along.
let _heroChunkCache = null;
function _loadHeroChunks() {
  if (_heroChunkCache) return _heroChunkCache;
  const map = new Map();
  try {
    const txt = fs.readFileSync("/home/claude-user/.claude/CLAUDE.md", "utf8");
    for (const line of txt.split("\n")) {
      // Project table rows: | `<name>` | <Role> | <Key paths> |
      const m = line.match(/^\|\s*`([a-zA-Z0-9_-]+)`\s*\|/);
      if (m) {
        const name = m[1];
        // First occurrence wins (later sections like "Browser stack" repeat names)
        if (!map.has(name)) map.set(name, line.trim());
      }
    }
  } catch (e) {
    console.warn("[cheap-model] could not parse hero chunks:", e.message);
  }
  _heroChunkCache = map;
  return _heroChunkCache;
}
function _systemPromptFor(project) {
  // Tight system prompt that REPLACES the default (which would auto-load
  // ~/.claude/CLAUDE.md). Includes ONLY this hero's table row, so other
  // heroes' descriptions never appear in this cheap call's context.
  const base = "You are a background helper for an agent chat. Output exactly what the user prompt asks (typically a small JSON object). Do not invent topics, facts, or topic words not present in the input. Do not use tools.";
  if (!project) return base;
  const chunk = _loadHeroChunks().get(project);
  if (!chunk) return base;
  return base + "\n\nHero context (this chat's project):\n" + chunk;
}

async function callOpenAI(model, maxTokens, systemPrompt, userContent) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }]
    })
  });
  if (!r.ok) return null;
  const data = await r.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

// Classify voice note transcript and auto-create orchestrator task if it's a new idea/direction

function runCheapClaude(prompt, tag, onParsed, project) {
  const want = (process.env.LLMT_BACKGROUND_PROVIDER || "claude").toLowerCase();
  if (want === "openai" && process.env.OPENAI_API_KEY) {
    return _runCheapOpenAI(prompt, tag, onParsed, project);
  }
  return _runCheapClaudeCli(prompt, tag, onParsed, project);
}

function _runCheapClaudeCli(prompt, tag, onParsed, project) {
  // Stand down while a transient throttle window is open: these background calls
  // are exactly the concurrent load that trips the server-side limit, and they
  // can wait. Fire-and-forget, so a delay is free (the user isn't blocked).
  const wait = throttle.remaining();
  if (wait > 0) {
    console.log(`[${tag}] throttled — deferring ${Math.round(wait / 1000)}s`);
    setTimeout(() => _spawnCheapClaudeCli(prompt, tag, onParsed, project), Math.min(wait, 60000));
    return;
  }
  _spawnCheapClaudeCli(prompt, tag, onParsed, project);
}

function _spawnCheapClaudeCli(prompt, tag, onParsed, project) {
  const args = [
    "-p", prompt,
    "--model", "haiku",
    "--output-format", "json",
    "--system-prompt", _systemPromptFor(project),
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
    // If this cheap call itself got throttled, extend the shared window so the
    // user-facing runner (and other background calls) back off too.
    if (throttle.isTransientRateLimit(out) || throttle.isTransientRateLimit(err)) {
      throttle.bump(8000);
      console.warn(`[${tag}] hit transient rate-limit — bumped shared throttle 8s`);
      return; // skip parsing the error payload; this round is simply dropped
    }
    try {
      const wrap = JSON.parse(out);
      const text = (wrap.result || wrap.text || out).toString();
      const json = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(json);
      await onParsed(parsed, err);
    } catch (e) {
      console.warn(`[${tag}] parse failed:`, e.message, "raw:", out.slice(0, 300));
    }
  });
  proc.on("error", e => console.error(`[${tag}] spawn error:`, e.message));
}

// OpenAI-backed equivalent of _runCheapClaudeCli. Reuses callOpenAI() and
// produces an object parsed from JSON content. Kept side-effect-symmetric
// with the claude path: silent warn on failure, no throw to the caller.
async function _runCheapOpenAI(prompt, tag, onParsed, project) {
  const SYSTEM = _systemPromptFor(project) + "\n\nYou return JSON only. No prose, no markdown fences, no commentary. The user prompt fully describes the required JSON shape.";
  try {
    const content = await callOpenAI("gpt-4o-mini", 800, SYSTEM, prompt);
    if (!content) {
      console.warn(`[${tag}] openai returned empty/null`);
      return;
    }
    const json = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(json); }
    catch (e) {
      console.warn(`[${tag}] openai parse failed:`, e.message, "raw:", content.slice(0, 300));
      return;
    }
    await onParsed(parsed, "");
  } catch (e) {
    console.error(`[${tag}] openai call error:`, e.message);
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

module.exports = { callOpenAI, runCheapClaude, _runCheapClaudeCli, _runCheapOpenAI };

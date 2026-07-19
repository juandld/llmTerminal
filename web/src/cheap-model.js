// Cheap/background model calls (Haiku CLI + OpenAI) used by supervisors,
// title-gen, classify, and ROI scoring. Extracted (refactor 2026-06-10).
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");
const throttle = require("./throttle");
const governor = require("./governor");
const runLedger = require("./run-ledger");

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

// Extract the first JSON value from cheap-model output. Models sometimes wrap
// the JSON in markdown fences AND append prose after the closing fence — the
// old anchored strip (`^```...|...```$`) only handled fences at the exact
// string edges, so trailing prose left the closing fence mid-string and the
// whole supervisor round was dropped as a parse failure. Order of attempts:
//   1. first fenced ``` block whose contents parse as JSON
//   2. the whole trimmed text as raw JSON
//   3. the first balanced {...} object that parses (string/escape aware)
// Returns the parsed value or throws (caller warns + drops the round).
function extractFirstJson(text) {
  const s = String(text == null ? "" : text);
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(s)) !== null) {
    try { return JSON.parse(m[1].trim()); } catch {}
  }
  try { return JSON.parse(s.trim()); } catch {}
  for (let i = s.indexOf("{"); i !== -1; i = s.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(i, j + 1)); } catch {}
          break;
        }
      }
    }
  }
  throw new Error("no parseable JSON found in model output");
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
  // Governor gate (WS3a): supervisors/background calls are machine-initiated
  // and fire-and-forget — when capped or in provider cooldown, drop this round
  // (same semantics as the throttle drop below). Both entry points of
  // _runCheapClaudeCli (immediate + throttle-deferred) land here.
  const _gv = governor.check("llmterminal-cheap");
  if (!_gv.ok) {
    console.log("[governor] parked " + tag + " — " + _gv.reason);
    return;
  }
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
  // Run-ledger L4: cheap/background spawns land in the same ledger. No llmT
  // session id here — the tag ("observer"/"decision-extractor"/"roi-haiku")
  // is the identity.
  const _ledger = runLedger.trackRun({ sessionId: "cheap:" + tag, pid: proc.pid, trigger: "cheap", model: "haiku", resumeOf: null, argv: args });
  let out = "", err = "";
  proc.stdout.on("data", c => { _ledger.output(c.length); out += c; });
  proc.stderr.on("data", c => err += c);
  const timer = setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, 45000);
  proc.on("close", async (code, signal) => {
    clearTimeout(timer);
    _ledger.exit(code, signal, "cheap-close");
    // Record-after (WS3a): one ledger row per cheap call. Cost comes from the
    // --output-format json wrapper; best-effort 0 when the output isn't JSON.
    let _cost = 0;
    try { _cost = Number(JSON.parse(out).total_cost_usd) || 0; } catch {}
    governor.record("llmterminal-cheap", "haiku", _cost, tag);
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
      const parsed = extractFirstJson(text);
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
    let parsed;
    try { parsed = extractFirstJson(content); }
    catch (e) {
      console.warn(`[${tag}] openai parse failed:`, e.message, "raw:", content.slice(0, 300));
      return;
    }
    await onParsed(parsed, "");
  } catch (e) {
    console.error(`[${tag}] openai call error:`, e.message);
  }
}

module.exports = { callOpenAI, runCheapClaude, extractFirstJson, _runCheapClaudeCli, _runCheapOpenAI };

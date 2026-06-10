// Provider model catalog + Claude alias resolution for llmTerminal.
// Fetches live model lists (OpenAI/Google/Anthropic), probes the real model id
// behind each Claude alias (fable/opus/sonnet/haiku), caches the labels, and
// Telegram-notifies on a model upgrade. Self-schedules a refresh on load.
// Extracted from server.js (refactor 2026-06-10, phase 3).
const fs = require("fs");
const path = require("path");
const { spawn: _spawnRaw } = require("child_process");
const { DATA_DIR } = require("./paths");

const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];
const _ALIAS_STATE_PATH = path.join(DATA_DIR, "claude-aliases.json");
let _claudeAliasModels = {}; // alias -> { id, label }
try { _claudeAliasModels = JSON.parse(fs.readFileSync(_ALIAS_STATE_PATH, "utf8")); } catch {}

function _prettyClaudeLabel(modelId) {
  // claude-opus-4-8[1m]  -> "Opus 4.8";  claude-fable-5  -> "Fable 5"
  const clean = String(modelId || "").replace(/\[.*?\]$/, "");
  // family + major.minor (opus/sonnet/haiku and any future same-shaped id)
  let m = clean.match(/claude-([a-z]+)-(\d+)-(\d+)/i);
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    return `${fam} ${m[2]}.${m[3]}`;
  }
  // family + single version (fable, etc.)
  m = clean.match(/claude-([a-z]+)-(\d+)$/i);
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    return `${fam} ${m[2]}`;
  }
  return modelId || "?";
}

function _probeAlias(alias) {
  return new Promise((resolve) => {
    let done = false;
    const proc = _spawnRaw("/usr/bin/claude", [
      "-p", ".", "--model", alias, "--output-format", "stream-json", "--verbose",
      "--dangerously-skip-permissions",
    ], { env: { HOME: "/home/claude-user", PATH: process.env.PATH, LANG: "en_US.UTF-8" }, uid: 1000, gid: 1000, stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    const finish = (val) => { if (done) return; done = true; try { proc.kill("SIGKILL"); } catch {} resolve(val); };
    const timer = setTimeout(() => finish(null), 25000);
    proc.stdout.on("data", (c) => {
      buf += c.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        try {
          const obj = JSON.parse(buf.slice(0, nl));
          if (obj.type === "system" && obj.subtype === "init" && obj.model) {
            clearTimeout(timer);
            finish(obj.model);
          }
        } catch {}
      }
    });
    proc.on("close", () => { clearTimeout(timer); finish(null); });
    proc.on("error", () => { clearTimeout(timer); finish(null); });
  });
}

async function _notifyTelegram(text) {
  try {
    const envTxt = fs.readFileSync("/home/claude-user/projects/narrativeHero/backend/.env", "utf8");
    const tok = (envTxt.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m) || [])[1];
    if (!tok) return;
    const chatId = "7373155120";
    await fetch(`https://api.telegram.org/bot${tok.trim().replace(/^["']|["']$/g, "")}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, parse_mode: "Markdown", text }),
    });
  } catch (e) { console.warn("[alias] telegram notify failed:", e.message); }
}

async function resolveClaudeAliases() {
  for (const alias of CLAUDE_ALIASES) {
    const realId = await _probeAlias(alias);
    if (!realId) { console.warn("[alias] probe failed for", alias); continue; }
    const prev = _claudeAliasModels[alias];
    const label = _prettyClaudeLabel(realId);
    if (!prev || prev.id !== realId) {
      console.log(`[alias] ${alias} -> ${realId} (${label})` + (prev ? ` [was ${prev.id}]` : ""));
      if (prev && prev.id !== realId) {
        _notifyTelegram(`🆙 *Claude model upgrade*: the \`${alias}\` alias now resolves to *${label}* (\`${realId}\`), was \`${prev.id}\`. The llmTerminal picker label updated automatically.`);
      }
      _claudeAliasModels[alias] = { id: realId, label };
      try { fs.writeFileSync(_ALIAS_STATE_PATH, JSON.stringify(_claudeAliasModels, null, 2)); } catch {}
    }
  }
}
// Resolve shortly after boot, then every 6h (cheap; picks up CLI auto-updates).
setTimeout(() => { resolveClaudeAliases().catch(e => console.warn("[alias] resolve error:", e.message)); }, 8000);
setInterval(() => { resolveClaudeAliases().catch(() => {}); }, 6 * 60 * 60 * 1000);

// Smartest-first rank lists. Anything in TOP_* shows up first in the listed
// order; anything not in TOP_* falls through to a created-date sort (newer first).
// Hand-curated so the picker order is predictable when a new provider model lands.
// Only chat-compatible flagships. -pro and -deep-research variants live on
// OpenAI's Responses API endpoint and 404 against /v1/chat/completions — they
// are also filtered out in `skipPatterns` below.
const OPENAI_TOP = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-chat-latest",
  "gpt-5.2",
  "gpt-5.1-codex-max", "gpt-5.1",
  "o3", "o4-mini",
  "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
  "o3-mini",
  "gpt-5.4-mini", "gpt-5.4-nano",
  "gpt-4o", "gpt-4o-mini",
];
const GOOGLE_TOP = [
  "gemini-3.1-pro-preview", "gemini-3-pro-preview",
  "gemini-pro-latest",
  "gemini-2.5-pro",
  "gemini-3.5-flash", "gemini-3.1-flash-lite",
  "gemini-flash-latest", "gemini-flash-lite-latest",
  "gemini-2.5-flash", "gemini-2.5-flash-lite",
  "gemini-2.0-flash", "gemini-2.0-flash-lite",
];
const CLAUDE_TOP = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

let _modelsCache = null;
let _modelsCacheTs = 0;
const MODELS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function _rankSort(models, topList) {
  const topIdx = new Map(topList.map((id, i) => [id, i]));
  return models.slice().sort((a, b) => {
    const ai = topIdx.has(a.id) ? topIdx.get(a.id) : Infinity;
    const bi = topIdx.has(b.id) ? topIdx.get(b.id) : Infinity;
    if (ai !== bi) return ai - bi;
    return (b.created || 0) - (a.created || 0);
  });
}

async function fetchProviderModels() {
  const now = Date.now();
  if (_modelsCache && now - _modelsCacheTs < MODELS_CACHE_TTL) return _modelsCache;

  const result = {
    claude: [],
    openai: [],
    google: [],
  };

  // Fetch Claude models from Anthropic API (same pattern as OpenAI/Google).
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      });
      if (r.ok) {
        const data = await r.json();
        const models = (data.data || [])
          .map(m => ({ id: m.id, name: m.display_name || m.id, created: m.created_at ? new Date(m.created_at).getTime() / 1000 : 0 }));
        result.claude = _rankSort(models, CLAUDE_TOP);
      }
    } catch (e) { console.warn("[models] Anthropic fetch failed:", e.message); }
  }
  // Fallback: if no API key or fetch failed, use short alias list so the
  // picker is never empty. Claude CLI accepts these aliases directly.
  if (!result.claude.length) {
    // Use live-resolved alias labels when available so the picker can never
    // drift from what `--model opus` actually runs. Falls back to a sane
    // static label only if the probe hasn't completed yet.
    const _static = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
    result.claude = ["fable", "opus", "sonnet", "haiku"].map(a => ({
      id: a,
      name: (_claudeAliasModels[a] && _claudeAliasModels[a].label) || _static[a],
    }));
  }

  const oaiKey = process.env.OPENAI_API_KEY;
  if (oaiKey) {
    try {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: "Bearer " + oaiKey },
      });
      if (r.ok) {
        const data = await r.json();
        const chatPrefixes = /^(gpt-|o\d|chatgpt-)/;
        // Exclude: non-chat (realtime/audio/search/transcribe/tts/whisper/dall/embed/moderat),
        // legacy text-completion (davinci/babbage/curie), image gen (gpt-image-*, chatgpt-image),
        // pure code-completion (codex variants without -chat or -max), instruct-only (-instruct).
        const skipPatterns = /^(gpt-image|chatgpt-image)|-(realtime|audio|search|transcri|tts|whisper|dall|embed|moderat|davinci|babbage|curie|instruct|pro|pro-\d|deep-research)$|-pro-\d{4}/i;
        const dated = /-\d{4}-\d{2}-\d{2}$/; // drop date-suffixed snapshots when the alias exists
        let chats = (data.data || []).filter(m => chatPrefixes.test(m.id) && !skipPatterns.test(m.id));
        const ids = new Set(chats.map(m => m.id));
        chats = chats.filter(m => {
          if (!dated.test(m.id)) return true;
          const alias = m.id.replace(dated, "");
          return !ids.has(alias);
        });
        result.openai = _rankSort(
          chats.map(m => ({ id: m.id, name: m.id, created: m.created })),
          OPENAI_TOP,
        );
      }
    } catch (e) { console.warn("[models] OpenAI fetch failed:", e.message); }
  }

  const gKey = process.env.GOOGLE_API_KEY;
  if (gKey) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${gKey}`);
      if (r.ok) {
        const data = await r.json();
        // Exclude: open-weight gemma, audio (lyria, tts), image gen (-image-, nano-banana),
        // robotics, customtools variants, embedding/code-completion specialties.
        const skip = /^(gemma|lyria|nano-banana|imagen)|(-image[-]|-image$|-tts[-]|-robotics|-customtools|-thinking-exp|-embedding|-aqa|-text-bison|-deep-research)/i;
        const models = (data.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map(m => ({ id: m.name.replace("models/", ""), name: m.displayName || m.name.replace("models/", "") }))
          .filter(m => !skip.test(m.id));
        result.google = _rankSort(models, GOOGLE_TOP);
      }
    } catch (e) { console.warn("[models] Google fetch failed:", e.message); }
  }

  _modelsCache = result;
  _modelsCacheTs = now;
  return result;
}

// Lets the DELETE /api/models route force a refresh without reaching into
// this module's private cache vars.
function clearModelsCache() { _modelsCache = null; _modelsCacheTs = 0; }

module.exports = { fetchProviderModels, resolveClaudeAliases, clearModelsCache };

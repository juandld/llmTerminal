// Provider support layer for llmTerminal: model->provider routing, per-project
// context blocks for non-Claude providers, conversation-history builders, and
// the FetchProc abort wrapper. Extracted from server.js (refactor 2026-06-10, phase 2).
const fs = require("fs");
const path = require("path");
const { PROJECTS_DIR } = require("../paths");
const { loadMessages } = require("../store");

const PROVIDER_MAP = {
  "": "claude", opus: "claude", sonnet: "claude", haiku: "claude",
  "gpt-4.1": "openai", "gpt-4.1-mini": "openai", "gpt-4.1-nano": "openai", "o3": "openai", "o4-mini": "openai",
  "gemini-2.5-pro": "google", "gemini-2.5-flash": "google",
};
function getProvider(model) {
  if (!model) return "claude";
  if (PROVIDER_MAP[model]) return PROVIDER_MAP[model];
  if (/^(gpt-|o\d)/.test(model)) return "openai";
  if (/^gemini-/.test(model)) return "google";
  if (/^claude-/.test(model)) return "claude";
  return "claude";
}

const CHAT_SYSTEM_PROMPT = "When presenting tabular data, ALWAYS use standard markdown pipe tables with a header row and separator row. Example:\n| Column A | Column B |\n| --- | --- |\n| value 1 | value 2 |\nNever use ASCII art tables, plain-text alignment, or code blocks for tabular data. The UI renders markdown tables as styled, mobile-friendly scrollable HTML tables.\n\nAfter you finish calling tools, you MUST end the turn with a short text reply that explains what you did and answers the user'''s actual question. Never end a turn on a tool call alone.";

// ----- Per-project context block for non-Claude providers -----
// Claude already auto-loads CLAUDE.md (and any --add-dir paths) — we don't
// touch its path. For OpenAI/Gemini we prepend the same flavor of info to the
// system prompt so the model knows: which project, where it lives on disk,
// what the project's conventions are, and what siblings exist.
function buildProjectContext(project) {
  if (!project) return "";
  const cwd = path.join(PROJECTS_DIR, project);
  const lines = [
    "# Active project: " + project,
    "# Working directory: " + cwd,
    "",
  ];
  // CLAUDE.md is the canonical per-project agent brief. Include verbatim.
  try {
    const claudeMd = fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf-8");
    if (claudeMd.trim()) {
      lines.push("## CLAUDE.md (project conventions)");
      // Cap at 18K chars (~4500 tokens) — most CLAUDE.md files are smaller.
      lines.push(claudeMd.length > 18000 ? claudeMd.slice(0, 18000) + "\n…(truncated)" : claudeMd);
      lines.push("");
    }
  } catch {}
  // Top-level listing so the model knows what files/dirs exist without
  // calling a tool first.
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true })
      .filter(d => !d.name.startsWith(".") && d.name !== "node_modules" && d.name !== ".venv")
      .slice(0, 60)
      .map(d => d.isDirectory() ? d.name + "/" : d.name);
    if (entries.length) {
      lines.push("## Top-level entries in working directory");
      lines.push(entries.join(", "));
      lines.push("");
    }
  } catch {}
  // Sibling projects — useful for "switch to X" / cross-project references.
  try {
    const siblings = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== project)
      .map(d => d.name);
    if (siblings.length) {
      lines.push("## Sibling projects (also under " + PROJECTS_DIR + "/)");
      lines.push(siblings.join(", "));
      lines.push("");
    }
  } catch {}
  return lines.join("\n");
}

// Build conversation history from SQLite messages for direct-API providers.
// Returns an array of {role, content} objects (OpenAI format).
function buildHistory(sessionId, currentPrompt, opts) {
  opts = opts || {};
  const includeToolContext = !!opts.includeToolContext;
  const msgs = loadMessages(sessionId);
  const skipRoles = new Set(["tool_result", "permission_denied", "permission_granted", "email_draft", "email_sent", "question"]);
  let charBudget = 400000; // ~100K tokens rough estimate

  // Walk forward this time so we can group tool_activity entries with the
  // assistant turn that follows them. Then we walk backward over the resulting
  // list to apply the budget cap and end up newest-first.
  const stitched = [];
  let pendingTools = [];
  for (const m of msgs) {
    if (m.stalled || m.recovered) continue;
    if (m.role === "tool_activity") {
      if (includeToolContext) {
        const summary = m.summary ? ": " + m.summary : "";
        pendingTools.push((m.tool_name || "tool") + summary);
      }
      continue;
    }
    if (skipRoles.has(m.role)) continue;
    if (m.role !== "user" && m.role !== "assistant") { pendingTools = []; continue; }
    if (!m.text) { pendingTools = []; continue; }
    let content = m.text;
    if (m.role === "assistant" && pendingTools.length) {
      // Fold the tool activity into the preceding assistant turn so OpenAI /
      // Gemini see what Claude (or a previous turn) did with tools.
      content = "[tools used: " + pendingTools.join("; ") + "]\n" + content;
    }
    if (m.role === "user") pendingTools = []; // tool activity belongs to the assistant turn that follows it
    stitched.push({ role: m.role, content });
    if (m.role === "assistant") pendingTools = [];
  }

  // Newest-first walk to enforce budget, then reverse back
  const candidates = [];
  for (let i = stitched.length - 1; i >= 0; i--) {
    const c = stitched[i];
    const cost = c.content.length;
    if (charBudget - cost < 0 && candidates.length > 0) break;
    charBudget -= cost;
    candidates.push(c);
  }
  candidates.reverse();
  candidates.push({ role: "user", content: currentPrompt });
  return candidates;
}

// Convert OpenAI-format history to Gemini contents format
function toGeminiContents(history) {
  return history.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

// Lightweight proc-like wrapper around an AbortController for fetch-based providers.
class FetchProc {
  constructor(controller) {
    this.controller = controller;
    this.pid = -1;
    this._closeHandlers = [];
  }
  kill() { this.controller.abort(); }
  on(event, handler) {
    if (event === "close") this._closeHandlers.push(handler);
  }
  _emitClose(code) {
    for (const h of this._closeHandlers) try { h(code); } catch {}
  }
}

module.exports = {
  getProvider, buildProjectContext, buildHistory, toGeminiContents,
  FetchProc, CHAT_SYSTEM_PROMPT,
};

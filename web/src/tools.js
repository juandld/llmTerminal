// Tool-result helpers: summarize a tool call for the UI, auto-create file
// previews, detect files touched by bash. Extracted (refactor 2026-06-10).
const fs = require("fs");
const path = require("path");
const { loadSessions } = require("./store");
const { logFileAttribution } = require("./attribution");

const previewMap = {}; // "sessionId:filePath" -> previewId

// Compact summary of a tool_use for the history log
function summarizeToolUse(toolName, input) {
  try {
    input = input || {};
    if (toolName === "Bash") return (input.command || "").slice(0, 140);
    if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") return input.file_path || "(file)";
    if (toolName === "Read") return input.file_path || "(file)";
    if (toolName === "Glob") return input.pattern || "";
    if (toolName === "Grep") return (input.pattern || "") + (input.path ? " in " + input.path : "");
    if (toolName === "WebFetch" || toolName === "WebSearch") return input.url || input.query || "";
    // Playwright MCP browser_*: pick the most identifying field per tool
    if (toolName === "browser_navigate" || toolName === "browser_navigate_back") return input.url || "";
    if (toolName === "browser_take_screenshot") return input.filename || input.element || "viewport";
    if (toolName === "browser_click" || toolName === "browser_hover" || toolName === "browser_drag") return input.element || input.ref || "";
    if (toolName === "browser_type" || toolName === "browser_fill_form") return (input.element || "") + (input.text ? " ← " + String(input.text).slice(0, 60) : "");
    if (toolName === "browser_press_key") return input.key || "";
    if (toolName === "browser_wait_for") return input.text || input.time || "";
    if (toolName === "browser_evaluate") return (input.function || "").slice(0, 140);
    if (toolName === "browser_select_option") return (input.element || "") + " → " + (input.values || []).join(",");
    if (toolName === "browser_resize") return (input.width || "?") + "x" + (input.height || "?");
    if (toolName.startsWith("browser_")) return Object.keys(input).slice(0, 2).map(k => k + "=" + String(input[k]).slice(0, 30)).join(" ");
    if (toolName.startsWith("mcp__")) {
      const parts = toolName.split("__");
      return (parts[1] || "") + ":" + (parts[2] || "");
    }
    // Generic MCP fallback: show the first 1-2 input fields
    if (input && typeof input === "object" && Object.keys(input).length) {
      return Object.keys(input).slice(0, 2).map(k => k + "=" + String(input[k]).slice(0, 30)).join(" ");
    }
  } catch {}
  return "";
}

function autoCreatePreview({ tool_name, input }, sessionId) {
  try {
    const filePath = input?.file_path;
    if (!filePath) return;
    let content = "";
    if (tool_name === "Write" && typeof input.content === "string") {
      content = input.content;
    } else {
      try { content = fs.readFileSync(filePath, "utf8"); } catch (e) { console.error("[auto-preview] read failed:", filePath, e.message); return; }
    }
    const title = path.basename(filePath);
    const mapKey = sessionId + ":" + filePath;
    const existingId = previewMap[mapKey];
    // Carry the source project so the drawer's "Project" toggle can aggregate
    // across sibling chats. Failing to resolve project is non-fatal — preview
    // still lands under session_id (chat-scoped view still works).
    const _proj = (loadSessions().find(s => s.id === sessionId) || {}).project || null;
    const body = JSON.stringify({
      type: "file",
      title,
      content: { body_text: content },
      session_id: sessionId,
      project: _proj,
    });
    // PUT to update if we already created a preview for this file, else POST
    const method = existingId ? "PUT" : "POST";
    const apiPath = existingId ? "/api/previews/" + existingId : "/api/previews";
    const req = http.request({
      hostname: "127.0.0.1",
      port: 8000,
      path: apiPath,
      method,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.id && !existingId) {
            previewMap[mapKey] = json.id;
            console.log("[auto-preview] created", json.id, "for", title);
          } else if (existingId) {
            console.log("[auto-preview] updated", existingId, "for", title);
          }
        } catch {}
      });
    });
    req.on("error", (e) => console.error("[auto-preview] failed:", e.message));
    req.write(body);
    req.end();
  } catch (e) {
    console.error("[auto-preview] error:", e.message);
  }
}





function autoDetectBashFiles(stdout, sessionId, cwd) {
  const EXT_TEXT = new Set(['.html','.htm','.md','.py','.json','.yaml','.yml','.csv','.txt']);
  const EXT_BIN  = new Set(['.pdf','.png','.jpg','.jpeg','.gif','.svg','.mp3','.wav','.m4a','.ogg','.webm']);
  const ALL_EXT_GROUP = '(?:html|htm|md|py|json|yaml|yml|csv|txt|pdf|png|jpg|jpeg|gif|svg|mp3|wav|m4a|ogg|webm)';
  const found = new Set();
  // Explicit PREVIEW: lines take priority
  for (const m of stdout.matchAll(/^PREVIEW:(.+)$/gm)) found.add(m[1].trim());
  // Scan for absolute paths under any project dir with known extensions
  for (const m of stdout.matchAll(/\/home\/claude-user\/projects\/[a-zA-Z0-9_-]+\/[^\s\\)\]>,.;]+/g)) {
    const p = m[0].replace(/[\)\]>,.;]+$/, '');
    const ext = path.extname(p).toLowerCase();
    if (EXT_TEXT.has(ext) || EXT_BIN.has(ext)) found.add(p);
  }
  // Scan for relative paths and resolve against the Bash cwd. Common case:
  // `python3 -c "...write_pdf('invoices/SQ-001.pdf')"` prints `invoices/SQ-001.pdf`
  // with no /home/... prefix. We only accept the path if (a) cwd is provided,
  // (b) the resolved path is still under /home/claude-user/projects/, and
  // (c) fs.existsSync confirms it. The existsSync gate kills false positives
  // from random "foo/bar.py" strings in usage messages.
  if (cwd && cwd.startsWith('/home/claude-user/projects/')) {
    const relRe = new RegExp("(^|[\\s\\(\\[\\\"'`])([\\w.-]+(?:/[\\w.-]+)+\\." + ALL_EXT_GROUP + ")(?=[\\s\\)\\]\\\"'`,;:]|$)", 'gmi');
    for (const m of stdout.matchAll(relRe)) {
      const rel = m[2];
      if (rel.startsWith('/') || rel.startsWith('..')) continue;
      const abs = path.resolve(cwd, rel);
      if (!abs.startsWith('/home/claude-user/projects/')) continue;
      found.add(abs);
    }
  }
  for (const filePath of found) {
    if (!fs.existsSync(filePath)) continue;
    // Cross-project leak guard: only pin a file if it lives under the session's
    // own project dir. A crankHero chat that happens to see langHero file paths
    // in Bash output does NOT pin them. "Files MADE in this chat" per David's model.
    if (cwd && cwd.startsWith('/home/claude-user/projects/') && !filePath.startsWith(cwd)) continue;
    // Robust attribution: log immediately, before any HTTP work that can fail.
    logFileAttribution(filePath, sessionId, 'Bash');
    const mapKey = sessionId + ':' + filePath;
    if (previewMap[mapKey]) continue;
    const ext = path.extname(filePath).toLowerCase();
    const isBin = EXT_BIN.has(ext);
    let bodyText;
    if (isBin) {
      bodyText = 'FILE_PATH:' + filePath;
    } else {
      try { bodyText = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    }
    const title = path.basename(filePath);
    const _proj = (loadSessions().find(s => s.id === sessionId) || {}).project || null;
    const body = JSON.stringify({ type: 'file', title, content: { body_text: bodyText }, session_id: sessionId, project: _proj });
    const req = http.request({
      hostname: '127.0.0.1', port: 8000, path: '/api/previews', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { const json = JSON.parse(data); if (json.id) { previewMap[mapKey] = json.id; console.log('[bash-preview] registered', json.id, 'for', title); } } catch {}
      });
    });
    req.on('error', e => console.error('[bash-preview] failed:', e.message));
    req.write(body); req.end();
  }
}


// ── Shared cheap-LLM spawner for supervisor-pattern observers ──
// Provider-agnostic: routes to Claude Haiku (default) or OpenAI gpt-4o-mini
// based on LLMT_BACKGROUND_PROVIDER env (claude|openai). Both paths emit the
// same (parsed, errString) callback contract. Fire-and-forget, ~45s budget.
// Falls back to claude if openai is selected but OPENAI_API_KEY is missing.
// (cheap-model fns moved to src/cheap-model.js)

module.exports = { summarizeToolUse, autoCreatePreview, autoDetectBashFiles };

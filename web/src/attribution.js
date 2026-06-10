// File-attribution: which agent/session touched which files, for the drawer.
// Extracted (refactor 2026-06-10).
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");
const { db } = require("./store");

const FILE_ATTRIBUTION_LOG = path.join(DATA_DIR, "file_attribution.jsonl");

function logFileAttribution(filePath, sessionId, tool) {
  if (!filePath || !sessionId) return;
  try {
    const line = JSON.stringify({ path: filePath, session_id: sessionId, tool: tool || "", ts: Date.now() }) + "\n";
    fs.appendFileSync(FILE_ATTRIBUTION_LOG, line);
  } catch (e) { console.error("[file-attr] append failed:", e.message); }
}

// Build the unified attribution map by merging three sources, last-write-wins by ts.
// Called per /api/drawer-files request; the work is bounded (one full pass of
// tool_activity rows + one JSONL read) and small enough not to need caching.
function buildAttributionMap() {
  const m = new Map(); // filePath -> { sessionId, ts, source }
  // (1) tool_activity Write/Edit/MultiEdit/NotebookEdit rows in messages.db.
  //     summary field for these tools is exactly the file_path.
  try {
    const rows = db.prepare("SELECT session_id, ts, data FROM messages WHERE role = 'tool_activity'").all();
    for (const r of rows) {
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      const tn = d.tool_name;
      if (tn !== "Write" && tn !== "Edit" && tn !== "MultiEdit" && tn !== "NotebookEdit") continue;
      const fp = (d.summary || "").trim();
      if (!fp.startsWith("/")) continue;
      const existing = m.get(fp);
      if (!existing || r.ts > existing.ts) m.set(fp, { sessionId: r.session_id, ts: r.ts, source: "tool_activity" });
    }
  } catch (e) { console.error("[file-attr] tool_activity scan failed:", e.message); }
  // (2) The sidecar JSONL — last-write-wins overrides DB when present (more recent).
  try {
    if (fs.existsSync(FILE_ATTRIBUTION_LOG)) {
      const txt = fs.readFileSync(FILE_ATTRIBUTION_LOG, "utf8");
      for (const line of txt.split("\n")) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (!r.path || !r.session_id) continue;
        const ts = r.ts || 0;
        const existing = m.get(r.path);
        if (!existing || ts >= existing.ts) m.set(r.path, { sessionId: r.session_id, ts, source: "jsonl" });
      }
    }
  } catch (e) { console.error("[file-attr] log read failed:", e.message); }
  return m;
}

// ---- /api/drawer-files ----
// Filesystem-derived view of files relevant to a session (or all sessions in a project).
// This is the source of truth for the drawer's file pins — it lists files that ACTUALLY
// EXIST under the session's project dir AND were created/modified during the session's
// active lifetime. No stale pins (file deleted → not in result); no missing pins (file
// created → in result); no cross-project leaks (file outside project dir → not in result).
//
// Inputs: ?session_id=X  OR  ?project=X
// Output: { files: [{ path, title, mtime_ms, ext, source_session_id, source_session_title }] }
//
// The DB (orchestratorHero /api/previews) is still consulted for agent-set labels and
// non-file previews (emails / documents) — those are merged client-side.
const DRAWER_EXT_WHITELIST = new Set([
  ".mp3",".wav",".m4a",".ogg",".webm",".aac",".flac",".opus",  // audio
  ".mp4",".mov",".webm",                                        // video
  ".pdf",".png",".jpg",".jpeg",".gif",".svg",                   // images / docs
  ".html",".htm",".md",".csv",".txt",".json",".yaml",".yml",    // text
  ".py",".js",".ts",".svelte",".sh",                            // code
]);
const DRAWER_EXCLUDED_DIRS = new Set([
  "node_modules","venv","__pycache__",".svelte-kit",".git",".next","dist","build",
  ".pytest_cache","image_cache","tts-cache",".cache",".npm",".local","previews",
  "snapshots","backup","backups",".tmp","tmp","__snapshots__",".bak",
]);
const DRAWER_TIME_BUFFER_MS = 2 * 60 * 1000; // still used as a small buffer for voice-note timestamp matching
const DRAWER_RESULT_CAP = 200;

// Walk a project dir and collect ALL candidate files matching ext/exclude rules.
// No time-window filtering — attribution decides membership downstream.
function _drawerWalkProjectFull(projectDir) {
  const out = [];
  const stack = [projectDir];
  while (stack.length && out.length < DRAWER_RESULT_CAP * 8) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.name.startsWith(".") && ent.name !== ".env") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (DRAWER_EXCLUDED_DIRS.has(ent.name)) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!DRAWER_EXT_WHITELIST.has(ext)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      out.push({ path: full, ext, mtime_ms: stat.mtimeMs, size: stat.size });
    }
  }
  return out;
}

module.exports = { FILE_ATTRIBUTION_LOG, logFileAttribution, buildAttributionMap, _drawerWalkProjectFull, DRAWER_TIME_BUFFER_MS, DRAWER_RESULT_CAP };

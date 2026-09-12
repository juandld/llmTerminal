// subtask-tracker.js — visibility into background Agent/Task tool calls still
// in flight for a session. Built 2026-08-23 after David asked for visibility
// into sub-tasks in execution: the chat feed's per-message "running" spinner
// (app-msg-helpers.js addTool()) only clears when the NEXT tool call starts,
// not when the specific tool's own result arrives — fine for sequential tools,
// but wrong for background Agent calls, where several can be in flight at once
// and each new one silently "settles" the previous one's spinner within
// seconds, even though the real subagent keeps running for minutes.
//
// The real completion signal for a background agent isn't a stream-json
// tool_result at all — it's a task-notification delivered later as a fresh
// turn. The Claude Code CLI records that delivery in the session's own
// transcript file (~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl)
// as a `{type:"queue-operation", operation:"enqueue", content:"<task-
// notification>...<tool-use-id>...</tool-use-id>..."}` row — the SAME
// tool_use_id the spawning Agent/Task tool_use block carried. Tailing that
// file (new bytes only, not a re-read) and matching that id against a
// registered "still running" set is what actually reflects reality.
const fs = require("fs");
const path = require("path");
const { CLAUDE_PROJECTS_DIR } = require("./paths");

const POLL_MS = 3000;
const _running = new Map();   // sessionId -> Map(toolUseId -> {name, startedAt})
const _watchers = new Map();  // sessionId -> {filePath, lastSize, timer}

// Only these tools spawn something that can genuinely outlive this stream
// event — everything else (Bash, Read, Edit...) is already covered by the
// existing per-message spinner and doesn't need tracking here.
const TRACKED_TOOLS = /^(Agent|Task)$/;

function _transcriptPath(project, claudeSessionId) {
  if (!project || !claudeSessionId) return null;
  return path.join(CLAUDE_PROJECTS_DIR, "-home-claude-user-projects-" + project, claudeSessionId + ".jsonl");
}

function registerStart(sessionId, toolUseId, name, project, claudeSessionId, broadcastFn) {
  if (!toolUseId || !TRACKED_TOOLS.test(name || "")) return;
  let m = _running.get(sessionId);
  if (!m) { m = new Map(); _running.set(sessionId, m); }
  m.set(toolUseId, { name, startedAt: Date.now() });
  _ensureWatch(sessionId, project, claudeSessionId, broadcastFn);
  _emit(sessionId, broadcastFn);
}

function _ensureWatch(sessionId, project, claudeSessionId, broadcastFn) {
  if (_watchers.has(sessionId)) return;
  const filePath = _transcriptPath(project, claudeSessionId);
  if (!filePath) return;
  let lastSize = 0;
  try { lastSize = fs.statSync(filePath).size; } catch {}
  const timer = setInterval(() => _poll(sessionId, broadcastFn), POLL_MS);
  timer.unref();
  _watchers.set(sessionId, { filePath, lastSize, timer });
}

function _poll(sessionId, broadcastFn) {
  const w = _watchers.get(sessionId);
  const m = _running.get(sessionId);
  if (!w) return;
  if (!m || m.size === 0) { clearInterval(w.timer); _watchers.delete(sessionId); return; }
  let stat;
  try { stat = fs.statSync(w.filePath); } catch { return; }
  if (stat.size <= w.lastSize) return;
  let chunk;
  try {
    const fd = fs.openSync(w.filePath, "r");
    const buf = Buffer.alloc(stat.size - w.lastSize);
    fs.readSync(fd, buf, 0, buf.length, w.lastSize);
    fs.closeSync(fd);
    chunk = buf.toString("utf8");
  } catch { return; }
  w.lastSize = stat.size;
  let changed = false;
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== "queue-operation" || row.operation !== "enqueue") continue;
    const content = String(row.content || "");
    if (!content.includes("<task-notification>")) continue;
    const idm = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(content);
    if (idm && m.delete(idm[1])) changed = true;
  }
  if (changed) _emit(sessionId, broadcastFn);
}

function listRunning(sessionId) {
  const m = _running.get(sessionId);
  if (!m) return [];
  return [...m.entries()].map(([tool_use_id, v]) => ({ tool_use_id, name: v.name, startedAt: v.startedAt }));
}

function _emit(sessionId, broadcastFn) {
  if (typeof broadcastFn !== "function") return;
  try { broadcastFn(sessionId, { type: "subtask_update", running: listRunning(sessionId) }); }
  catch (e) { console.error("[subtask-tracker] broadcast failed:", e.message); }
}

module.exports = { registerStart, listRunning };

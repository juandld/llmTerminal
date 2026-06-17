// Session auto-titling: derive a short title from the conversation via the
// cheap model. Extracted (refactor 2026-06-10).
const { loadMessages, loadSessions, saveSessions, updateSessionInStore } = require("./store");
const { broadcastToSession } = require("./ws/broadcast");
const { runCheapClaude } = require("./cheap-model");
const { spawn } = require("child_process");
const { _bwrapWrap } = require("./bwrap");
const _titlingInProgress = new Set();

function generateSessionTitle(sessionId) {
  if (_titlingInProgress.has(sessionId)) return; // already titling this session
  const sessions0 = loadSessions();
  const session0 = sessions0.find(s => s.id === sessionId);
  if (!session0) return;
  const convoMsgs = loadMessages(sessionId).filter(m =>
    (m.role === "user" || m.role === "assistant") && m.text && !m.synthetic && !m.stalled);
  if (!convoMsgs.length) return;
  // Always include the FIRST user message (it sets the topic) plus the last N
  // — slicing only the tail can drop the original framing on long threads,
  // pushing the titler to guess from late tool-chatter and bleed in unrelated
  // context. With the first turn anchored, the title hugs the actual topic.
  const _firstUser = convoMsgs.find(m => m.role === "user");
  const _tail = convoMsgs.slice(-7);
  const _seen = new Set();
  const _ordered = [];
  for (const m of [_firstUser, ..._tail].filter(Boolean)) {
    const key = m.ts || (m.role + ":" + (m.text || "").slice(0, 40));
    if (_seen.has(key)) continue;
    _seen.add(key);
    _ordered.push(m);
  }
  const _convo = _ordered
    .map(m => (m.role === "user" ? "User: " : "Assistant: ") + String(m.text).slice(0, 500))
    .join("\n\n");
  // Override the default system prompt (which auto-loads ~/.claude/CLAUDE.md
  // — David's global ecosystem map mentions Mandarin/langHero, and the
  // titler used to graft those topics onto unrelated voiceover work). Custom
  // system prompt keeps the titler scoped to the conversation text only.
  const _systemPrompt = "You are a session titler. You will receive a chat transcript. Output ONLY a 4-to-6-word title for THAT conversation. Use only words/concepts present in the transcript. Never invent topics not mentioned. No quotes, no markdown, no period, no preface.";
  const prompt = "Transcript:\n\n" + _convo.slice(0, 2500);
  const _titleArgs = [
    "-p", prompt,
    "--system-prompt", _systemPrompt,
    "--dangerously-skip-permissions",
    "--disallowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "NotebookEdit",
  ];
  // Title-gen runs in the camoHero sandbox if the session belongs to it,
  // matching the same isolation as the main claude spawn for that project.
  const _titleWrap = _bwrapWrap(session0.project || "", _titleArgs);
  _titlingInProgress.add(sessionId);
  const _doneTitling = () => _titlingInProgress.delete(sessionId);
  const proc = spawn(_titleWrap.cmd, _titleWrap.args, {
    cwd: "/home/claude-user",
    env: { HOME: "/home/claude-user", TERM: "dumb", LANG: "en_US.UTF-8", PATH: process.env.PATH },
    uid: 1000, gid: 1000,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let out = "";
  let err = "";
  proc.stdout.on("data", c => { out += c.toString(); });
  proc.stderr.on("data", c => { err += c.toString(); });
  const timer = setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} _doneTitling(); }, 30000);
  proc.on("close", (code) => {
    clearTimeout(timer);
    _doneTitling();
    if (code !== 0) {
      console.warn("[title-gen] claude exited non-zero for", sessionId, "code=", code, "err=", err.slice(0, 200));
      return;
    }
    let title = (out || "").trim();
    title = title.replace(/^["\u201c\u2018\u0060]+|["\u201d\u2019\u0060]+$/g, "");
    title = title.replace(/^[#*\s]+|[\s.]+$/g, "");
    title = title.split(/\r?\n/)[0].trim();
    // Reject obvious "I tried to do something" sentence outputs
    const wordCount = title.split(/\s+/).filter(Boolean).length;
    const looksLikeSentence = /[:;]/.test(title) || /^(I |It |Here|Sorry|Sure|Let me|Looking|The )/.test(title);
    if (!title || title.length > 70 || wordCount > 8 || looksLikeSentence) {
      console.warn("[title-gen] unusable output for", sessionId, ":", JSON.stringify(out).slice(0, 200));
      return;
    }
    const sessions = loadSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    session.title = title;
    session.titleGenerated = true;
    // Remember the user-turn count at this titling so the trigger knows when the
    // chat has grown enough to warrant a refresh.
    session.titleUserMsgs = loadMessages(sessionId).filter(m => m.role === "user").length;
    saveSessions(sessions);
    console.log("[title-gen] renamed", sessionId, "\u2192", title);
    broadcastToSession(sessionId, { type: "title_updated", sessionId, title });
  });
  proc.on("error", (e) => {
    clearTimeout(timer);
    _doneTitling();
    console.warn("[title-gen] spawn error for", sessionId, ":", e.message);
  });
}


module.exports = { generateSessionTitle };

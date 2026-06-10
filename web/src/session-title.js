// Session auto-titling: derive a short title from the conversation via the
// cheap model. Extracted (refactor 2026-06-10).
const { loadMessages, loadSessions, saveSessions, updateSessionInStore } = require("./store");
const { broadcastToSession } = require("./ws/broadcast");
const { runCheapClaude } = require("./cheap-model");

function generateSessionTitle(sessionId) {
  if (_titlingInProgress.has(sessionId)) return; // already titling this session
  const sessions0 = loadSessions();
  const session0 = sessions0.find(s => s.id === sessionId);
  if (!session0) return;
  const convoMsgs = loadMessages(sessionId).filter(m =>
    (m.role === "user" || m.role === "assistant") && m.text && !m.synthetic && !m.stalled);
  if (!convoMsgs.length) return;
  const _convo = convoMsgs.slice(-8)
    .map(m => (m.role === "user" ? "User: " : "Assistant: ") + String(m.text).slice(0, 500))
    .join("\n\n");
  const prompt = "You are titling a chat conversation. Output ONLY the title — 4 to 6 words, no quotes, no markdown, no period, no preface. DO NOT use any tools. DO NOT ask for clarification. If the conversation is unclear, make your best guess from the available context.\n\n"
    + _convo.slice(0, 2500);
  const _titleArgs = [
    "-p", prompt,
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


// ---- Provider routing ----
const {
  getProvider, buildProjectContext, buildHistory, toGeminiContents,
  FetchProc, CHAT_SYSTEM_PROMPT,
} = require("./providers/context");
// ---- Run OpenAI streaming chat completion (with MCP tool-call loop) ----

// ---- Run Google Gemini streaming chat completion ----

// ---- Run claude -p for a single message, stream JSON back ----

module.exports = { generateSessionTitle };

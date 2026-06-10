let ws=null, session=null, busy=false, historyOffset=0, grantedPerms=new Set();
let currentVoiceNonce=null; // WS-bound capability for voice-note uploads; cleared on disconnect
let sentHistory=[], historyIdx=-1, currentDraft="";
let lastRenderedTs=0;
try{const sh=localStorage.getItem("llmt_input_history");if(sh)sentHistory=JSON.parse(sh)||[];}catch{}
function pushInputHistory(text){
  text=(text||"").trim();if(!text)return;
  if(sentHistory[0]===text)return; // dedupe consecutive
  sentHistory.unshift(text);
  if(sentHistory.length>100)sentHistory.length=100;
  try{localStorage.setItem("llmt_input_history",JSON.stringify(sentHistory));}catch{}
}
function autoResizeInput(el){el.style.height="44px";el.style.height=Math.min(el.scrollHeight,140)+"px";}
// ---- Phase 1 state: outbox, heartbeat, scroll/selection persistence ----
let outbox=[];
try{outbox=JSON.parse(localStorage.getItem("llmt_outbox")||"[]")}catch{}
function saveOutbox(){try{localStorage.setItem("llmt_outbox",JSON.stringify(outbox))}catch{}}
function genMsgId(){return(self.crypto&&crypto.randomUUID)?crypto.randomUUID():"m_"+Date.now()+"_"+Math.random().toString(36).slice(2,8)}
let lastServerMsgTs=Date.now();
let staleTimer=null;
let isSynced=false;
let reconnectTimer=null;  // tracks pending auto-reconnect so we can cancel on session switch
let connectEpoch=0;       // incremented on every connect(); stale handlers check this before acting
function flushOutbox(){
  if(!ws||ws.readyState!==1) return;
  for(const item of outbox){
    try{ws.send(JSON.stringify({type:"prompt",client_id:item.id,text:item.text,images:item.images||[],resend:true}))}catch{}
  }
}
function saveInputSelection(){try{localStorage.setItem("llmt_draft_sel",JSON.stringify({s:inp.selectionStart,e:inp.selectionEnd}))}catch{}}
let scrollSaveT=null;
function saveChatScroll(){
  clearTimeout(scrollSaveT);
  scrollSaveT=setTimeout(()=>{
    try{
      const atBottom=(chat.scrollHeight-chat.scrollTop-chat.clientHeight)<30;
      localStorage.setItem("llmt_chat_scroll",JSON.stringify({top:chat.scrollTop,atBottom}));
    }catch{}
  },120);
}
let stickToBottom=true;
function updateStickyFromScroll(){
  stickToBottom=(chat.scrollHeight-chat.scrollTop-chat.clientHeight)<60;
}
function scrollToBottomIfSticky(){
  if(stickToBottom){chat.scrollTop=chat.scrollHeight}
}
function scrollToBottomForce(){
  chat.scrollTop=chat.scrollHeight;
  stickToBottom=true;
}
function restoreChatScroll(){
  try{
    const s=JSON.parse(localStorage.getItem("llmt_chat_scroll")||"null");
    if(!s||s.atBottom){chat.scrollTop=chat.scrollHeight}
    else{chat.scrollTop=s.top}
  }catch{chat.scrollTop=chat.scrollHeight}
}

function setInputFromHistory(text){
  inp.value=text;
  inp.style.height="44px";
  inp.style.height=Math.min(inp.scrollHeight,140)+"px";
  // Move cursor to end
  const len=inp.value.length;
  inp.setSelectionRange(len,len);
}
let thinkingEl=null;
let pendingImages=[]; // {data: base64, mimeType: string, preview: dataUrl}
let messageQueue=[]; // queued messages to send when Claude is idle (client-side fast path)
let _serverQueueDepth=0;  // server-persistent queue depth

const chat=document.getElementById("chat"), inp=document.getElementById("inp");
const sendBtn=document.getElementById("sendBtn"), stopBtn=document.getElementById("stopBtn");
const sbList=document.getElementById("sbList");
// projSel was removed; provide a synthetic stub so any leftover refs are harmless
const projSel = { value: "ALL" };
// ── Win95 model picker (replaces the old <select>-based selectors) ────────────
// One overlay (#modelPickerMenu), two trigger buttons (#modelPickerBtn topbar,
// #omModelPickerBtn in mobile overflow). Smartest-first within each provider.
const modelPickLabel   = () => document.getElementById("modelPickLabel");
const omModelPickLabel = () => document.getElementById("omModelPickLabel");
let _allModelsData = null;
// Default all collapsed — the menu's whole point is to be compact, click to drill in.
// On open() we auto-expand the section that contains the currently-selected model.
const _provExpanded = { claude: false, openai: false, google: false };

// (model-picker fns moved to app-modelpicker.js)
let _allSessions = [];
let _searchQuery = "";
try { _searchQuery = localStorage.getItem("llmt_sb_search") || ""; } catch {}
// Server-side content search: session IDs whose message bodies match _searchQuery.
let _contentMatchIds = new Set();
let _contentMatchQuery = "";
let _contentSearchTimer = null;
function _runContentSearch(q) {
  if (_contentSearchTimer) clearTimeout(_contentSearchTimer);
  const trimmed = (q || "").trim();
  if (!trimmed || trimmed.length < 2) {
    _contentMatchIds = new Set();
    _contentMatchQuery = trimmed;
    return;
  }
  _contentSearchTimer = setTimeout(async () => {
    try {
      const r = await fetch(apiUrl("/api/search?q=" + encodeURIComponent(trimmed)));
      const data = await r.json();
      // Drop stale responses if user kept typing.
      if (trimmed !== (_searchQuery || "").trim()) return;
      _contentMatchIds = new Set(data.sessionIds || []);
      _contentMatchQuery = trimmed;
      _renderSidebar();
    } catch (e) { console.error("content search failed:", e); }
  }, 220);
}
let _availableProjects = [];
function _defaultProject() {
  try { const lp = localStorage.getItem("llmt_project"); if (lp && lp !== "ALL") return lp; } catch {}
  if (session && session.project) return session.project;
  return _availableProjects[0] || "narrativeHero";
}
function _updateNewSessionLabel() {
  const btn = document.getElementById("newSessionBtn");
  if (!btn) return;
  const proj = _defaultProject();
  btn.textContent = proj ? ("+ New in " + proj) : "+ New Session";
  btn.title = "Tap: new chat in " + proj + ". Long-press / right-click: pick a different project.";
}
const badge=document.getElementById("badge"), ds=document.getElementById("ds"), dsText=document.getElementById("dsText");
const starBtn=document.getElementById("starBtn");

// Reflect the current session's starred state in the topbar star icon.
function updateStarBtn() {
  if (!starBtn) return;
  if (!session) { starBtn.style.display = "none"; return; }
  starBtn.style.display = "";
  const on = !!session.starred;
  starBtn.textContent = on ? "★" : "☆";
  starBtn.classList.toggle("topbar-star-on", on);
  starBtn.title = on ? "Starred — high-priority in the sidebar (tap to unstar)" : "Star — keeps this chat at high priority in the sidebar";
}

async function toggleSessionStar() {
  if (!session) return;
  const next = !session.starred;
  // Optimistic UI update — flip first, then persist.
  session.starred = next;
  updateStarBtn();
  try {
    await fetch(apiUrl("/api/sessions/" + session.id + "/state"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: next }),
    });
    try { loadSessions(); } catch {}
  } catch (e) {
    // Revert on failure
    session.starred = !next;
    updateStarBtn();
    console.warn("[star] toggle failed:", e);
  }
}

// Detect base path (works at root or under /terminal/)
const BASE=location.pathname.replace(/\/+$/,"")||"";
function apiUrl(path){return BASE+path}

async function init(){
  const projects=await fetch(apiUrl("/api/projects")).then(r=>r.json());
  _availableProjects = projects.slice();
  // Search input wiring
  const sbSearchEl = document.getElementById("sbSearch");
  if (sbSearchEl) {
    sbSearchEl.value = _searchQuery;
    sbSearchEl.addEventListener("input", () => {
      _searchQuery = sbSearchEl.value || "";
      try { localStorage.setItem("llmt_sb_search", _searchQuery); } catch {}
      _runContentSearch(_searchQuery);
      _renderSidebar();
    });
    // Kick off content search at load so a persisted query produces hits without typing.
    if (_searchQuery) _runContentSearch(_searchQuery);
  }
  // New-session button: tap = create in last project, long-press = picker
  const newBtn = document.getElementById("newSessionBtn");
  if (newBtn) {
    newBtn.addEventListener("click", (e) => { e.preventDefault(); newSession(_defaultProject()); });
    let _nbTimer = null, _nbLongPressed = false;
    newBtn.addEventListener("touchstart", () => {
      _nbLongPressed = false;
      _nbTimer = setTimeout(() => { _nbLongPressed = true; _nbTimer = null; openNewSessionPicker(); }, 500);
    }, { passive: true });
    newBtn.addEventListener("touchend", (e) => {
      if (_nbTimer) { clearTimeout(_nbTimer); _nbTimer = null; }
      if (_nbLongPressed) e.preventDefault();  // suppress the synthetic click after long-press
    });
    newBtn.addEventListener("touchmove", () => { if (_nbTimer) { clearTimeout(_nbTimer); _nbTimer = null; } });
    newBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); openNewSessionPicker(); });
  }

  // Restore last session from URL hash or localStorage
  const hashSession = location.hash.replace(/^#/,"").trim();
  const savedSession = hashSession || localStorage.getItem("llmt_session");

  // Load session list first so we can verify the saved session exists
  await loadSessions();

  if(savedSession){
    // Verify session exists before connecting
    const allSessions = await fetch(apiUrl("/api/sessions")).then(r=>r.json());
    const found = allSessions.find(s=>s.id===savedSession);
    if(found){
      connect(found.project, found.id);
    } else {
      localStorage.removeItem("llmt_session"); location.hash="";
      connect(_defaultProject(), null);
    }
  } else {
    connect(_defaultProject(), null);
  }
}

let _showArchived = false;
let _collapsedProjects = new Set();
try { _collapsedProjects = new Set(JSON.parse(localStorage.getItem("llmt_sb_collapsed") || "[]")); } catch {}
function _persistCollapsed() {
  try { localStorage.setItem("llmt_sb_collapsed", JSON.stringify([..._collapsedProjects])); } catch {}
}
function relativeTime(ts) {
  if (!ts) return "";
  const ageMs = Date.now() - ts;
  const m = Math.floor(ageMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return d + "d ago";
  if (d < 30) return Math.floor(d / 7) + "w ago";
  const date = new Date(ts);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function recencyBucket(ts) {
  const age = Date.now() - (ts || 0);
  if (age < 86400000) return "Today";
  if (age < 2 * 86400000) return "Yesterday";
  if (age < 7 * 86400000) return "This week";
  if (age < 30 * 86400000) return "This month";
  return "Older";
}
const BUCKET_ORDER = ["Today", "Yesterday", "This week", "This month", "Older"];
const RECENT_BUCKETS = new Set(["Today", "Yesterday", "This week"]);
function showSessionInfo_state(_x){} // marker

// Debounced trigger for the Haiku ROI re-score on the top-N sidebar items.
// Fires at most once per 60s so a re-render storm doesn't fan out into many
// /api/priority-roi-rescore calls.
let _rescoreLastFiredAt = 0;
let _rescoreInflight = false;
function triggerPriorityRescore(sessionIds) {
  if (!sessionIds || !sessionIds.length) return;
  const now = Date.now();
  if (now - _rescoreLastFiredAt < 60 * 1000) return;
  if (_rescoreInflight) return;
  _rescoreLastFiredAt = now;
  _rescoreInflight = true;
  fetch(apiUrl("/api/priority-roi-rescore"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_ids: sessionIds }),
  })
    .then(r => r.json()).then(d => {
      if (d && d.scored > 0) { try { loadSessions(); } catch {} }
    })
    .catch(() => {})
    .finally(() => { _rescoreInflight = false; });
}

// Tap the priority badge → small inline popover with the breakdown so the
// score is auditable. No black-box magic — every factor is shown.
function showPriorityBreakdown(x, anchorEl) {
  // Close any open popover first
  document.querySelectorAll(".sb-prio-pop").forEach(e => e.remove());
  const b = x.priority_breakdown || {};
  const lines = [
    `${x.priority_score || 0} = urgency ${b.urgency || 0} × ROI ${b.roi || 0} / 100`,
    `State: ${b.state || "?"}` + (b.has_deadline ? "  · deadline" : "") + (b.starred ? "  · ★" : ""),
    b.project_multiplier !== null ? `Project ROI base: ${b.project_multiplier} (${x.project})` : null,
    (b.matched_people && b.matched_people.length) ? `People: ${b.matched_people.join(", ")}` : null,
    b.has_money ? "Money / deal mentioned" : null,
    typeof b.haiku_score === "number"
      ? `Haiku: ${b.haiku_score}/100 — ${b.haiku_why || ""}`
      : "Haiku: (no rescore yet)",
    `Age: ${b.age_days != null ? b.age_days + "d" : "?"}`,
  ].filter(Boolean);
  const pop = mk("div", "sb-prio-pop");
  pop.innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join("");
  // Position near the anchor — appended to body, fixed-positioned just below
  document.body.appendChild(pop);
  const r = anchorEl.getBoundingClientRect();
  pop.style.top = (r.bottom + 4) + "px";
  pop.style.right = (window.innerWidth - r.right) + "px";
  const dismiss = (e) => {
    if (pop.contains(e.target)) return;
    pop.remove();
    document.removeEventListener("click", dismiss, true);
  };
  setTimeout(() => document.addEventListener("click", dismiss, true), 0);
}

function showSessionInfo(x, anchorEl) {
  // Native confirm + action menu — simple for mobile
  const state = computeSessionState(x);
  const isDone = state === "done";
  const action = confirm(
    (x.title || "(untitled)") + "\n\n" +
    "Project: " + (x.project || "?") + "\n" +
    "Messages: " + (x.messageCount || 0) + "\n" +
    "State: " + (state || "?") + "\n\n" +
    (isDone
      ? "Tap OK to mark this chat ACTIVE again (cancel to leave as DONE)."
      : "Tap OK to mark this chat DONE (cancel to leave it active).")
  );
  if (action) {
    fetch(apiUrl("/api/sessions/" + x.id + "/state"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manualDone: !isDone }),
    }).then(() => loadSessions()).catch(()=>{});
  }
}

// Compute chat state from session metadata. 5 states for triage:
//   blocked   — agent waiting on user (question / permission_denied) — RED, urgent
//   decision  — action item (email_draft) — YELLOW, your turn
//   responded — agent answered, no action needed — GREEN, read at leisure
//   working   — agent mid-task — GREY, leave alone
//   done      — logical end (email sent / manually marked / 24h+ idle responded) — MUTED, archive-ready
function computeSessionState(s) {
  if (!s) return "";
  const role = s.lastMessageRole || "";
  const ageMin = (Date.now() - (s.lastActive || 0)) / 60000;
  // Email reply (Phase B reactivation) — pulls the session back to "decision":
  // you need to read the reply and decide what to do.
  if (role === "email_reply") return s.manualDone ? "done" : "decision";
  // Email sent: only done when actually opened in Gmail or confirmed sent
  if (role === "email_sent") return "done";
  if (role === "email_draft" && s.emailOpened) return "done";
  if (role === "email_draft") return "decision";
  // Non-email: manualDone means done
  if (s.manualDone) return "done";
  if (role === "question" || role === "permission_denied") return "blocked";
  // V1.1: user_waiting — David sent a message but agent hasn't produced output yet
  if (s.awaitingResponse && role === "user") return "user_waiting";
  // "working" rolls of activity bumps lastActive on each tool_use/tool_result the
  // CLI streams. If we've gone >5 min without any bump, the claude process
  // almost certainly died mid-run — surface as "stalled" so it stops looking
  // like it's still thinking.
  if (role === "user" || role === "tool_activity" || role === "tool_result" || role === "permission_granted") {
    return ageMin > 5 ? "stalled" : "working";
  }
  // Responded: assistant replied, awaiting either a continuation from David or
  // an explicit "done" signal (manualDone, email_sent, contract-check supervisor
  // marking complete). We used to also flip to "done" when David had viewed the
  // session AND let it sit ≥30 min, but that false-positived on mid-task pauses
  // (look away → come back tomorrow → continue). The supervisor's contract-check
  // is the right place to decide "this conversation is actually finished"; this
  // UI shouldn't guess. 3-day-dormant fallback remains as a long-tail archive
  // nudge for sessions truly abandoned.
  if (role === "assistant") {
    if (ageMin > 3*24*60) return "done";
    return "responded";
  }
  return "";
}
// Pending optimistic updates kept across loadSessions() roundtrips so a slow
// server response doesn't wipe instant UI feedback.
const _pendingViewed = new Map();  // sessionId -> ts
const _pendingDone   = new Map();  // sessionId -> ts
function _applyPendingToList(list) {
  for (const [id, ts] of _pendingViewed) {
    const s = list.find(x => x.id === id);
    if (s && (s.lastViewed || 0) < ts) s.lastViewed = ts;
  }
  for (const [id, ts] of _pendingDone) {
    const s = list.find(x => x.id === id);
    if (s && !s.manualDone) s.manualDone = ts;
  }
}
function markSessionViewed(sessionId) {
  if (!sessionId) return;
  const now = Date.now();
  _pendingViewed.set(sessionId, now);
  const local = _allSessions.find(x => x.id === sessionId);
  if (local) local.lastViewed = now;
  _renderSidebar();
  fetch(apiUrl("/api/sessions/" + sessionId + "/viewed"), { method: "POST" })
    .then(() => { _pendingViewed.delete(sessionId); })
    .catch(() => {});
}
function markSessionDone(sessionId) {
  if (!sessionId) return;
  const now = Date.now();
  _pendingDone.set(sessionId, now);
  const local = _allSessions.find(x => x.id === sessionId);
  if (local) local.manualDone = now;
  _renderSidebar();
  fetch(apiUrl("/api/sessions/" + sessionId + "/state"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manualDone: true }),
  })
  .then(() => { _pendingDone.delete(sessionId); loadSessions(); })
  .catch(() => {});
}
const STATE_ICONS = {
  blocked:      "❗",       // ❗
  decision:     "⚡",       // ⚡
  user_waiting: "◉",       // ◉  David sent a message, agent hasn't started
  stalled:      "⚠️",       // process exited mid-run, no final response
  responded:    "✓",       // ✓
  working:      "⏳",       // ⏳
  done:         "✅",       // ✅
};
const STATE_PRIORITY = { blocked: 0, decision: 1, user_waiting: 1.3, stalled: 1.5, responded: 2, working: 3, done: 4 };


// Round-robin through sessions that need attention. Tap = jump to next.
function attentionSessionsList() {
  return (_allSessions || [])
    .filter(s => !s.archived)
    .map(s => ({ s, st: computeSessionState(s) }))
    .filter(({st}) => st === "blocked" || st === "decision" || st === "user_waiting" || st === "stalled" || st === "responded")
    .sort((a, b) => {
      if (STATE_PRIORITY[a.st] !== STATE_PRIORITY[b.st]) return STATE_PRIORITY[a.st] - STATE_PRIORITY[b.st];
      return (b.s.lastActive || 0) - (a.s.lastActive || 0);
    })
    .map(({s}) => s);
}
function nextAttentionSession() {
  const list = attentionSessionsList();
  if (!list.length) return;
  const curIdx = list.findIndex(s => s.id === (session && session.id));
  const next = list[(curIdx + 1) % list.length];
  if (next) {
    resumeSession(next);
    showAttentionBanner(next);
  }
}
function showAttentionBanner(s) {
  let banner = document.getElementById("attBanner");
  if (!banner) {
    banner = mk("div", "att-banner"); banner.id = "attBanner";
    const chatEl = document.getElementById("chat");
    chatEl.parentNode.insertBefore(banner, chatEl);
  }
  const state = computeSessionState(s);
  const icon = STATE_ICONS[state] || "";
  const snippet = s.lastSnippet || "";
  const project = s.project || "";
  banner.innerHTML = "";
  const left = mk("div","att-banner-left");
  left.innerHTML = '<span class="att-banner-icon">' + icon + '</span> <strong>' + esc(s.title || "Untitled") + '</strong>';
  if (project) left.innerHTML += ' <span class="att-banner-proj">' + esc(project) + '</span>';
  banner.appendChild(left);
  if (snippet) {
    const snipEl = mk("div","att-banner-snippet");
    snipEl.textContent = snippet;
    banner.appendChild(snipEl);
  }
  banner.style.display = "flex";
  // Auto-hide after 5s
  if (banner._timer) clearTimeout(banner._timer);
  banner._timer = setTimeout(() => { banner.style.display = "none"; }, 5000);
  banner.onclick = () => { banner.style.display = "none"; };
}
function refreshAttentionCounter() {
  // Update topbar attention button (desktop)
  const topAtt = document.getElementById("topbarAtt");
  if (topAtt) {
    const list = attentionSessionsList();
    const n = list.length;
    const icon = document.getElementById("topbarAttIcon");
    const text = document.getElementById("topbarAttText");
    if (n === 0) {
      if (icon) icon.textContent = "✅";
      if (text) text.textContent = "";
      topAtt.classList.remove("has-attention");
    } else {
      if (icon) icon.textContent = "🔔 " + n;
      if (text) text.textContent = "";
      topAtt.classList.add("has-attention");
    }
  }
}

// (sidebar render fns moved to app-sidebar.js)
// (ws lifecycle moved to app-ws.js)
function _clearInput(){
  inp.value=""; inp.style.height="44px"; localStorage.removeItem("llmt_draft"); clearImages();
}

// ── Phone wake / tab resume: force-reconnect so chat is always fresh ──
document.addEventListener("visibilitychange",()=>{
  if(document.hidden) return;
  // Page just became visible (phone unlocked, tab refocused)
  if(!session) return;
  const wsAlive = ws && ws.readyState===WebSocket.OPEN;
  const stale = Date.now()-lastServerMsgTs > 10000; // >10s since last server msg
  if(!wsAlive || stale){
    const sid=session.id, proj=session.project; // capture before any async weirdness
    console.log("[visibility] page visible, reconnecting (wsAlive="+wsAlive+", stale="+stale+", session="+sid+")");
    chat.innerHTML=""; lastRenderedTs=0;
    connect(proj,sid); // connect() already cleans up old ws
  }
});

function send(){
  const rawText=inp.value.trim();
  // Prepend attached-file context if user has checkmarks in the drawer.
  // After send, the selection clears (next message starts fresh).
  const preamble = _attachedFilesPreamble();
  const text = preamble ? (preamble + (rawText || "(no message — attached files for context)")) : rawText;
  if(!text&&pendingImages.length===0) return;
  if (preamble) { selectedPreviewIds.clear(); _saveSelection(); renderDrawer(); renderSelectedTray(); }
  // Request notification permission on first send (idempotent if already decided)
  requestNotifPermission();
  // Push to input history (for ArrowUp recall)
  pushInputHistory(text);
  historyIdx=-1;
  currentDraft="";
  // If busy, queue the message
  if(busy){
    const images=pendingImages.map(i=>({data:i.data,mimeType:i.mimeType}));
    const previews=pendingImages.map(i=>i.preview);
    const queuedId=genMsgId();
    messageQueue.push({text,images,previews,clientId:queuedId});
    addQueued(text,previews,queuedId);
    _clearInput();
    renderQueueCount();
    return;
  }
  const prompt=text||"Describe the attached image(s).";
  const images=pendingImages.map(i=>({data:i.data,mimeType:i.mimeType}));
  const previews=pendingImages.map(i=>i.preview);

  if(!ws||ws.readyState!==1){
    const clientId=genMsgId();
    outbox.push({id:clientId,text,images,ts:Date.now()});saveOutbox();
    // Reconnect — outbox will be flushed when "ready" arrives (no ws.onopen overwrite,
    // which would race the flush and double-send the prompt)
    connect(session?.project||_defaultProject(),session?.id);
    addUser(text,previews,clientId); _clearInput();
    setBusy(true);
    return;
  }
  const clientId=genMsgId();
  outbox.push({id:clientId,text,images,ts:Date.now()});saveOutbox();
  ws.send(JSON.stringify({type:"prompt",client_id:clientId,text:prompt,images}));
  addUser(text,previews,clientId);
  // Tag live-rendered message so history replay doesn't duplicate
  const liveTs=Date.now();
  const last=chat.lastElementChild;
  if(last){last.dataset.ts=liveTs; lastRenderedTs=liveTs}
  _clearInput(); inp.setAttribute("placeholder","Message Claude...");
  localStorage.removeItem("llmt_draft_sel");
  setBusy(true);
}

// ── Image handling ──
// Anthropic's many-image rule rejects conversations where ANY image exceeds
// 2000px on a side once you accumulate several images. We downscale here so
// one phone screenshot can't poison a long session.
const MAX_IMAGE_DIM = 2000;
function _pushImageRaw(file){
  const reader=new FileReader();
  reader.onload=()=>{
    const dataUrl=reader.result;
    const base64=dataUrl.split(",")[1];
    const mimeType=file.type||"image/png";
    pendingImages.push({data:base64,mimeType,preview:dataUrl});
    renderImagePreviews();
  };
  reader.readAsDataURL(file);
}
async function addImage(file){
  try {
    const bitmap=await createImageBitmap(file);
    const maxSide=Math.max(bitmap.width,bitmap.height);
    if(maxSide<=MAX_IMAGE_DIM){
      if(bitmap.close)bitmap.close();
      _pushImageRaw(file);
      return;
    }
    const scale=MAX_IMAGE_DIM/maxSide;
    const w=Math.round(bitmap.width*scale);
    const h=Math.round(bitmap.height*scale);
    const canvas=document.createElement("canvas");
    canvas.width=w;canvas.height=h;
    canvas.getContext("2d").drawImage(bitmap,0,0,w,h);
    if(bitmap.close)bitmap.close();
    const outMime="image/jpeg";
    const dataUrl=canvas.toDataURL(outMime,0.92);
    const base64=dataUrl.split(",")[1];
    pendingImages.push({data:base64,mimeType:outMime,preview:dataUrl});
    renderImagePreviews();
  } catch(err){
    console.error("addImage downscale failed, sending original:",err);
    _pushImageRaw(file);
  }
}
function handleImgFiles(e){
  const files=e.target.files||[];
  for(const f of files){
    if(f.type.startsWith("image/")) addImage(f);
  }
  e.target.value="";
}
function clearImages(){pendingImages=[];renderImagePreviews()}
function removeImage(i){pendingImages.splice(i,1);renderImagePreviews()}
function renderImagePreviews(){
  const bar=document.getElementById("imgBar");
  bar.innerHTML="";
  pendingImages.forEach((img,i)=>{
    const d=document.createElement("div");d.className="img-preview";
    d.innerHTML='<img src="'+img.preview+'"><button class="x" onclick="removeImage('+i+')">&times;</button>';
    bar.appendChild(d);
  });
}

// Paste handler
document.addEventListener("paste",(e)=>{
  const items=e.clipboardData?.items;
  if(!items)return;
  for(const item of items){
    if(item.type.startsWith("image/")){
      e.preventDefault();
      addImage(item.getAsFile());
    }
  }
});
// Drop handler
chat.addEventListener("dragover",(e)=>{e.preventDefault()});
chat.addEventListener("drop",(e)=>{
  e.preventDefault();
  for(const file of (e.dataTransfer?.files||[])){
    if(file.type.startsWith("image/")) addImage(file);
  }
});

function loadMore(){
  if(ws&&ws.readyState===1&&historyOffset>0) ws.send(JSON.stringify({type:"load_more",before:historyOffset,count:20}));
}
function interrupt(){
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:"interrupt"}));
}

// ── DOM helpers ──
// (message-render fns moved to app-render.js)
function describePermAction(msg){
  const name=msg.tool_name||"unknown",input=msg.tool_input||{};
  if(name==="Write") return "write to "+(input.file_path||"a file");
  if(name==="Edit") return "edit "+(input.file_path||"a file");
  if(name==="Bash") return "run: "+(input.command||"a command").slice(0,120);
  if(name==="Read") return "read "+(input.file_path||"a file");
  if(name==="Glob"||name==="Grep") return name.toLowerCase()+" search";
  // MCP tools: show a cleaner name like "Gmail: search messages"
  if(name.startsWith("mcp__")){
    const parts=name.split("__");
    const service=parts[1]||"";
    const action=(parts[2]||"").replace(/_/g," ");
    return service+": "+action+" "+JSON.stringify(input).slice(0,80);
  }
  return name+" "+JSON.stringify(input).slice(0,100);
}
function buildPermString(msg){
  const name=msg.tool_name||"";
  if(name==="Bash"&&msg.tool_input?.command){
    const cmd=msg.tool_input.command.split(" ")[0];
    return "Bash("+cmd+":*)";
  }
  return name;
}
function grantPerm(perm){
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:"permission_grant",permission:perm}));
}
function grantAllPerms(extraPerm){
  // Grant all common tool permissions + any MCP tool that triggered this
  const allPerms=["Read","Write","Edit","Glob","Grep","Bash","Agent","WebFetch","WebSearch","NotebookEdit","Bash(*:*)"];
  if(extraPerm&&!allPerms.includes(extraPerm)) allPerms.push(extraPerm);
  // Send all at once but only auto-retry on the last one
  for(let i=0;i<allPerms.length;i++){
    if(ws&&ws.readyState===1){
      const isLast=i===allPerms.length-1;
      ws.send(JSON.stringify({type:"permission_grant",permission:allPerms[i],autoRetry:isLast}));
    }
  }
}
function addPermissionCard(msg){
  removeThinking();
  const d=mk("div","msg permission");
  const label=mk("div","msg-label perm-label");label.textContent="Permission Required";
  const tool=mk("div","perm-tool");tool.textContent=describePermAction(msg);
  const detail=mk("div","perm-detail");detail.textContent=msg.message||"";
  const actions=mk("div","perm-actions");
  const allow=mk("button","perm-btn perm-allow");allow.textContent="Allow";
  const allowAll=mk("button","perm-btn perm-allow");allowAll.textContent="Allow All";allowAll.title="Grant all permissions for this session";
  const deny=mk("button","perm-btn perm-deny");deny.textContent="Deny";
  allow.onclick=()=>{
    const perm=buildPermString(msg);
    grantPerm(perm);
    actions.innerHTML='<span class="perm-result allowed">Allowed — retrying automatically...</span>';
  };
  allowAll.onclick=()=>{
    const thisPerm=buildPermString(msg);
    grantAllPerms(thisPerm);
    actions.innerHTML='<span class="perm-result allowed">All permissions granted — retrying automatically...</span>';
  };
  deny.onclick=()=>{
    actions.innerHTML='<span class="perm-result denied">Denied</span>';
  };
  actions.appendChild(allow);actions.appendChild(allowAll);actions.appendChild(deny);
  d.appendChild(label);d.appendChild(tool);d.appendChild(detail);d.appendChild(actions);
  chat.appendChild(d);scrollToBottomForce();
}
function addPermissionCardFromHistory(msg){
  // Check if this permission is currently in the granted set
  const perm=buildPermString({tool_name:msg.tool_name,tool_input:msg.tool_input});
  const isGranted=grantedPerms&&grantedPerms.has(perm);
  const d=mk("div","msg permission");
  const label=mk("div","msg-label perm-label");label.textContent="Permission Required";
  const tool=mk("div","perm-tool");tool.textContent=describePermAction({tool_name:msg.tool_name,tool_input:msg.tool_input});
  const detail=mk("div","perm-detail");detail.textContent=msg.message||"";
  d.appendChild(label);d.appendChild(tool);d.appendChild(detail);
  if(isGranted){
    const res=mk("div","perm-result allowed");res.textContent="(allowed)";
    d.appendChild(res);
  }else{
    // Still needs grant — show actionable buttons
    const actions=mk("div","perm-actions");
    const allow=mk("button","perm-btn perm-allow");allow.textContent="Allow";
    const allowAll=mk("button","perm-btn perm-allow");allowAll.textContent="Allow All";
    allow.onclick=()=>{grantPerm(perm);actions.innerHTML='<span class="perm-result allowed">Allowed — send a message to retry</span>';};
    allowAll.onclick=()=>{grantAllPerms(perm);actions.innerHTML='<span class="perm-result allowed">All permissions granted — send a message to retry</span>';};
    actions.appendChild(allow);actions.appendChild(allowAll);
    d.appendChild(actions);
  }
  chat.appendChild(d);
}

let sessionPreviews=[], expandedPreviewId=null, fileFilter="all", knownPreviewIds=new Set();
let sortMode=(function(){try{return localStorage.getItem("llmt_file_sort")||"newest"}catch{return "newest"}})(); // newest|oldest|name|type

// Map a preview entry to a {kind, icon, label} based on type or filename extension.
// Drives both the visible icon and the .fp-kind-* CSS class for the color accent.
// (files-drawer fns moved to app-drawer.js)
function addTool(name,body){
  // Mark any previously-running tool entry as settled — we're moving on.
  const prev = chat.querySelector(".msg.tool.running:last-of-type");
  if (prev) prev.classList.remove("running");
  const d=mk("div","msg tool running");
  const n=mk("div","tool-name");
  n.innerHTML='<span class="tool-spinner" aria-hidden="true">⟳</span><span class="tool-name-text"></span>';
  n.querySelector(".tool-name-text").textContent = name;
  const b=mk("div","tool-body"); b.textContent=body;
  d.appendChild(n); d.appendChild(b);
  chat.appendChild(d);
  scrollToBottomIfSticky();
}
function addSystem(text){const d=mk("div","msg system");d.textContent=text;chat.appendChild(d)}
// Render a locally-queued (client busy) message as a real user bubble with the
// same dashed-yellow "queued" treatment we use for server-broadcast queue items.
// Keeps the visual identical whether the queue lives client-side or server-side
// so David can always see *what* is pending, not just a depth count.
function addQueued(text,imagePreviews,clientId){
  const d=mk("div","msg user queued");
  if(clientId) d.dataset.clientId=clientId;
  d.dataset.localQueued="1";
  if(imagePreviews&&imagePreviews.length){
    imagePreviews.forEach(src=>{const img=document.createElement("img");img.src=src;d.appendChild(img)});
  }
  d.appendChild(document.createTextNode(text));
  const badge=mk("span","queued-badge");
  badge.textContent="queued — will fire when current turn ends";
  badge.title="Held client-side because Claude is still mid-turn. It will send automatically as soon as the current response finishes.";
  d.appendChild(badge);
  chat.appendChild(d);
  scrollToBottomIfSticky();
}
function renderQueueCount(){
  const total = (messageQueue?.length || 0) + (_serverQueueDepth || 0);
  let el=document.getElementById("queueCount");
  if(!el){el=mk("span","queue-count");el.id="queueCount";document.querySelector(".topbar").appendChild(el)}
  el.textContent = total ? (total + " queued") : "";
  el.classList.toggle("has-queue", total > 0);
  el.title = total
    ? "Pending messages waiting for Claude to finish — they will fire automatically."
    : "";
}
function addError(text){const d=mk("div","msg error");d.textContent="Error: "+text;chat.appendChild(d);scrollToBottomForce()}

// Permission functions defined above (consolidated)

function showThinking(){
  removeThinking();
  thinkingEl=mk("div","thinking-indicator");
  thinkingEl.textContent="thinking";
  chat.appendChild(thinkingEl);
  scrollToBottomIfSticky();
}
function removeThinking(){if(thinkingEl){thinkingEl.remove();thinkingEl=null;}}

function fmtTable(block){
  const rows=block.trim().split('\n').filter(r=>r.trim());
  if(rows.length<2)return null;
  // check separator row (---|---|---)
  const sep=rows[1].trim().replace(/^\|/,'').replace(/\|$/,'');
  if(!/^[\s:|-]+$/.test(sep))return null;
  const parse=r=>r.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
  const heads=parse(rows[0]);
  let html='<div class="md-table-wrap"><table><thead><tr>';
  heads.forEach(h=>{html+='<th>'+h+'</th>';});
  html+='</tr></thead><tbody>';
  for(let i=2;i<rows.length;i++){
    const cells=parse(rows[i]);
    html+='<tr>';
    cells.forEach(c=>{html+='<td>'+c+'</td>';});
    html+='</tr>';
  }
  html+='</tbody></table></div>';
  return html;
}

function fmt(text){
  let h=esc(text);
  h=h.replace(/```(\w*)\n([\s\S]*?)```/g,(m,lang,code)=>{
    const enc=encodeURIComponent(code);
    return '<div class="code-block"><button class="code-copy" data-code="'+enc+'" onclick="copyCodeFromBtn(this)">Copy</button><pre><code>'+code+'</code></pre></div>';
  });
  // Parse markdown tables before line breaks
  h=h.replace(/(^|\n)(\|.+\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.+\|[ \t]*(?:\n|$))+)/gm,(m,pre,tbl)=>{
    const rendered=fmtTable(tbl);
    return rendered?(pre+rendered):(pre+tbl);
  });
  h=h.replace(/`([^`]+)`/g,'<code>$1</code>');
  h=h.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  h=h.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<span class="link-island"><a href="$2" target="_blank" rel="noopener">$1</a></span>');
  h=h.replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g,'$1<span class="link-island"><a href="$2" target="_blank" rel="noopener">$2</a></span>');
  h=h.replace(/\n/g,'<br>');
  return h;
}

function addSystemNote(text){
  const d=document.createElement('div');
  d.className='msg system-note';
  d.textContent=text;
  d.style.cssText='align-self:center;font-size:11px;color:var(--dim);font-style:italic;padding:4px 12px;opacity:.7';
  chat.appendChild(d);
  scrollToBottomIfSticky && scrollToBottomIfSticky();
}

function setBusy(b){
  busy=b;sendBtn.disabled=b||!isSynced;sendBtn.style.display=b?"none":"";stopBtn.style.display=b?"":"none";
  if(!b){
    if(window.innerWidth>768)inp.focus();
    // Drain queue
    if(messageQueue.length>0){
      const next=messageQueue.shift();
      renderQueueCount();
      // Remove the locally-queued bubble for this specific item (matched by
      // client_id we stamped at queue time). send() will create the real bubble.
      if(next.clientId){
        const stale=chat.querySelector('.msg.user.queued[data-local-queued="1"][data-client-id="'+CSS.escape(next.clientId)+'"]');
        if(stale) stale.remove();
      }
      // Send it
      pendingImages=next.images?.map((img,i)=>({data:img.data,mimeType:img.mimeType,preview:next.previews?.[i]||""}))||[];
      inp.value=next.text;
      setTimeout(send,100);
    }
  }
}
function setStatus(t,s){dsText.textContent=t;ds.className="dot-status "+s}

// ── Browser status polling ──
let _browserUrl = null;
let _browserPollTimer = null;
const browserBtn = document.getElementById("browserBtn");
const browserUrlEl = document.getElementById("browserUrl");

async function pollBrowserStatus(){
  if(!session || !session.project) return;
  try {
    const r = await fetch(apiUrl("/api/browser-status?project="+encodeURIComponent(session.project)));
    const d = await r.json();
    const omBtn = document.getElementById("omBrowserBtn");
    const omDot = document.getElementById("omBrowserDot");
    const omUrl = document.getElementById("omBrowserUrl");
    const overflowBtn = document.getElementById("overflowBtn");
    if(d.running && d.url){
      _browserUrl = d.url;
      const vncUrl = "/vnc/" + session.project.toLowerCase() + "/";
      const act = d.activity || 'idle';  // navigating|active|idle|dormant
      const idleSec = d.idleSec || 0;
      const ago = idleSec < 60 ? idleSec + 's' : idleSec < 3600 ? Math.round(idleSec/60) + 'm' : Math.round(idleSec/3600) + 'h';

      // Desktop button
      browserBtn.href = vncUrl;
      browserBtn.classList.remove("off", "live", "navigating", "active", "idle", "dormant");
      browserBtn.classList.add(act);
      browserBtn.title = (d.title || d.url) + ' — ' + act + ' (last change ' + ago + ' ago)';
      try { browserUrlEl.textContent = new URL(d.url).hostname; } catch { browserUrlEl.textContent = ""; }

      // Mobile overflow browser item
      if(omBtn){ omBtn.href = vncUrl; omBtn.style.display = ""; }
      if(omDot) { omDot.classList.remove("live","navigating","active","idle","dormant"); omDot.classList.add(act); }
      if(omUrl){ try { omUrl.textContent = new URL(d.url).hostname; } catch { omUrl.textContent = ""; } }
      if(overflowBtn) {
        overflowBtn.classList.add("has-browser");
        overflowBtn.classList.remove("nav-navigating","nav-active","nav-idle","nav-dormant");
        overflowBtn.classList.add("nav-" + act);
      }
    } else {
      _setBrowserOff(omBtn, omDot, omUrl, overflowBtn);
    }
  } catch {
    const omBtn = document.getElementById("omBrowserBtn");
    const omDot = document.getElementById("omBrowserDot");
    const omUrl = document.getElementById("omBrowserUrl");
    const overflowBtn = document.getElementById("overflowBtn");
    _setBrowserOff(omBtn, omDot, omUrl, overflowBtn);
  }
}
function _setBrowserOff(omBtn, omDot, omUrl, overflowBtn){
  _browserUrl = null;
  browserBtn.removeAttribute("href");
  browserBtn.classList.add("off");
  browserBtn.classList.remove("live");
  browserBtn.title = "No browser active";
  browserUrlEl.textContent = "";
  if(omBtn){ omBtn.removeAttribute("href"); omBtn.style.display = "none"; }
  if(omDot) omDot.classList.remove("live");
  if(omUrl) omUrl.textContent = "";
  if(overflowBtn) overflowBtn.classList.remove("has-browser");
}
function handleBrowserClick(e){
  if(!_browserUrl){ e.preventDefault(); return false; }
  return true;
}
function startBrowserPoll(){
  stopBrowserPoll();
  pollBrowserStatus();
  _browserPollTimer = setInterval(pollBrowserStatus, 8000);
}
function stopBrowserPoll(){
  if(_browserPollTimer){ clearInterval(_browserPollTimer); _browserPollTimer=null; }
}

// ── Overflow menu ──
function toggleOverflowMenu(){
  const menu = document.getElementById("overflowMenu");
  menu.classList.toggle("open");
  if(menu.classList.contains("open")){
    setTimeout(()=>{
      const closer = (e)=>{ if(!e.target.closest("#topbarOverflow")) closeOverflowMenu(); };
      document.addEventListener("click", closer, {once:true});
      document.addEventListener("touchstart", closer, {once:true, passive:true});
    }, 50);
  }
}
function closeOverflowMenu(){
  document.getElementById("overflowMenu").classList.remove("open");
}
// Sync mobile files badge with desktop badge
function syncMobileFilesBadge(){
  const desktop = document.getElementById("filesBadge");
  const mobile = document.getElementById("filesBadgeMobile");
  if(desktop && mobile){
    mobile.style.display = desktop.style.display;
    mobile.textContent = desktop.textContent;
  }
}

function toggleSB(){
  const sb=document.getElementById("sidebar");
  sb.classList.toggle("show");
  try{localStorage.setItem("llmt_sidebar_open",String(sb.classList.contains("show")))}catch{}
}
function mk(tag,cls){const d=document.createElement(tag);d.className=cls;return d}
function esc(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML}

function addToolActivityLine(toolName, summary){
  const line=mk("div","msg tool-activity-line");
  line.textContent="\u25B8 "+(toolName||"?")+(summary?": "+summary:"");
  chat.appendChild(line);
  scrollToBottomIfSticky();
}

function addApiErrorCard(msg){
  const card=mk("div","msg api-error-card");
  const label=mk("div","msg-label api-err-label");
  label.textContent="API Error"+(msg.status_code?" "+msg.status_code:"");
  const body=mk("div","api-err-body");
  body.textContent=msg.message||"Anthropic returned an error.";
  const meta=mk("div","api-err-meta");
  meta.textContent=msg.request_id?"request_id: "+msg.request_id:"";
  const actions=mk("div","api-err-actions");
  const retry=mk("button","api-err-retry");retry.textContent="Retry last message";
  retry.onclick=()=>{
    // Find the last user message from our client history and resend
    const msgs=[...chat.querySelectorAll(".msg.user")];
    if(!msgs.length){retry.textContent="Nothing to retry";retry.disabled=true;return}
    const lastText=msgs[msgs.length-1].textContent;
    if(!lastText)return;
    inp.value=lastText;
    retry.textContent="Resending...";retry.disabled=true;
    setTimeout(()=>send(),50);
  };
  actions.appendChild(retry);
  // 401 = Claude auth expired. Surface a one-tap re-auth button to the
  // in-browser flow so David never needs an SSH terminal to recover.
  const is401 = String(msg.status_code||"") === "401" || /401|authenticat/i.test(msg.message||"");
  if(is401){
    body.textContent = "Claude authentication expired — chats are failing. Re-authenticate in your browser (no SSH needed).";
    const reauth=mk("a","api-err-retry");
    reauth.textContent="🔑 Re-authenticate Claude";
    reauth.href=(typeof apiUrl==="function"?apiUrl("/claude-auth.html"):"/terminal/claude-auth.html");
    reauth.target="_blank"; reauth.rel="noopener";
    reauth.style.cssText="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:#000;font-weight:600";
    actions.insertBefore(reauth, actions.firstChild);
  }
  card.appendChild(label);card.appendChild(body);
  if(msg.request_id)card.appendChild(meta);
  card.appendChild(actions);
  chat.appendChild(card);
  scrollToBottomForce();
}

function toggleChatSearch(){
  const bar=document.getElementById("chatSearchBar");
  const input=document.getElementById("chatSearchInput");
  const wasHidden=bar.classList.contains("hidden");
  bar.classList.toggle("hidden");
  if(wasHidden){input.focus();input.select()}
  else{input.value="";runChatSearch()}
}

function runChatSearch(){
  const input=document.getElementById("chatSearchInput");
  const countEl=document.getElementById("chatSearchCount");
  const q=(input?.value||"").trim();
  const msgs=chat.querySelectorAll(".msg");
  if(!q){
    msgs.forEach(m=>{m.classList.remove("search-dim","search-hit");m.querySelectorAll("mark[data-sh]").forEach(n=>{const t=document.createTextNode(n.textContent);n.parentNode.replaceChild(t,n);n.parentNode.normalize&&n.parentNode.normalize()})});
    if(countEl)countEl.textContent="";
    return;
  }
  const lower=q.toLowerCase();
  let hitCount=0, firstHit=null;
  msgs.forEach(m=>{
    // Remove previous highlights
    m.querySelectorAll("mark[data-sh]").forEach(n=>{const t=document.createTextNode(n.textContent);n.parentNode.replaceChild(t,n)});
    m.normalize&&m.normalize();
    const txt=m.textContent||"";
    if(txt.toLowerCase().includes(lower)){
      m.classList.add("search-hit");
      m.classList.remove("search-dim");
      hitCount++;
      if(!firstHit)firstHit=m;
      // Highlight text nodes
      highlightIn(m, lower);
    }else{
      m.classList.remove("search-hit");
      m.classList.add("search-dim");
    }
  });
  if(countEl)countEl.textContent=hitCount+" match"+(hitCount!==1?"es":"");
  if(firstHit)firstHit.scrollIntoView({behavior:"smooth",block:"center"});
}

function highlightIn(el, lowerQuery){
  const walker=document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const nodes=[];
  let n;while(n=walker.nextNode())nodes.push(n);
  nodes.forEach(node=>{
    const text=node.nodeValue;
    const lower=text.toLowerCase();
    const idx=lower.indexOf(lowerQuery);
    if(idx<0)return;
    const before=text.slice(0,idx);
    const match=text.slice(idx,idx+lowerQuery.length);
    const after=text.slice(idx+lowerQuery.length);
    const frag=document.createDocumentFragment();
    if(before)frag.appendChild(document.createTextNode(before));
    const mark=document.createElement("mark");mark.setAttribute("data-sh","1");mark.textContent=match;
    frag.appendChild(mark);
    if(after)frag.appendChild(document.createTextNode(after));
    node.parentNode.replaceChild(frag,node);
  });
}

function toggleSummary(){
  const p=document.getElementById("summaryPanel");
  const wasHidden=p.classList.contains("hidden");
  p.classList.toggle("hidden");
  if(wasHidden)requestSummary();
}

function requestSummary(){
  if(!ws||ws.readyState!==1){
    document.getElementById("summaryBody").innerHTML='<div class="drawer-empty">Not connected</div>';
    return;
  }
  document.getElementById("summaryBody").innerHTML='<div class="drawer-empty">Computing\u2026</div>';
  try{ws.send(JSON.stringify({type:"get_summary"}))}catch{}
}

function renderSummary(data){
  const body=document.getElementById("summaryBody");
  if(!data){body.innerHTML='<div class="drawer-empty">No data</div>';return}
  let html='';
  const stats=[
    ["Messages", data.user_messages||0],
    ["Files written", (data.files_written||[]).length],
    ["Files edited", (data.files_edited||[]).length],
    ["Files read", (data.files_read||[]).length],
    ["Bash commands", (data.bash_commands||[]).length],
    ["Questions asked", data.questions||0],
  ];
  html+='<div class="summary-section"><h3 class="msg-label">Activity</h3>';
  stats.forEach(([k,v])=>{html+='<div class="summary-stat">'+k+'<span>'+v+'</span></div>'});
  if(typeof data.total_cost_usd==="number"){
    html+='<div class="summary-stat">Total cost<span>$'+data.total_cost_usd.toFixed(4)+'</span></div>';
  }
  if(data.duration_seconds){
    const h=Math.floor(data.duration_seconds/3600),m=Math.floor((data.duration_seconds%3600)/60);
    html+='<div class="summary-stat">Active time<span>'+(h?h+"h ":"")+m+'m</span></div>';
  }
  html+='</div>';
  const lists=[
    ["Files written", data.files_written],
    ["Files edited", data.files_edited],
    ["Files read", data.files_read],
    ["Bash commands", data.bash_commands],
    ["MCP tools used", data.mcp_tools],
  ];
  lists.forEach(([label,items])=>{
    if(!items||!items.length)return;
    html+='<div class="summary-section"><h3 class="msg-label">'+label+' ('+items.length+')</h3><ul class="summary-list">';
    items.slice(0,30).forEach(x=>{html+='<li>'+esc(x)+'</li>'});
    if(items.length>30)html+='<li style="color:var(--dim)">\u2026 and '+(items.length-30)+' more</li>';
    html+='</ul></div>';
  });
  body.innerHTML=html||'<div class="drawer-empty">No activity yet</div>';
}

function copyCodeFromBtn(btn){
  try{
    const code=decodeURIComponent(btn.getAttribute("data-code")||"");
    navigator.clipboard.writeText(code).then(()=>{
      btn.classList.add("copied");
      const orig=btn.textContent;btn.textContent="Copied";
      setTimeout(()=>{btn.classList.remove("copied");btn.textContent=orig},1200);
    }).catch(()=>{btn.textContent="Failed"});
  }catch(e){btn.textContent="Failed"}
}

// Long-press / right-click copy on messages
(function setupMessageCopy(){
  let pressTimer=null;
  chat.addEventListener("touchstart",(e)=>{
    const msg=e.target.closest&&e.target.closest(".msg");
    if(!msg)return;
    pressTimer=setTimeout(()=>{copyMessageText(msg)},600);
  },{passive:true});
  chat.addEventListener("touchend",()=>clearTimeout(pressTimer));
  chat.addEventListener("touchmove",()=>clearTimeout(pressTimer));
  chat.addEventListener("contextmenu",(e)=>{
    const msg=e.target.closest&&e.target.closest(".msg");
    if(!msg)return;
    // Only intercept right-click on message body, not inside code block copy button
    if(e.target.closest(".code-copy"))return;
    e.preventDefault();copyMessageText(msg);
  });
})();
function copyMessageText(msg){
  const txt=msg.textContent||"";
  if(!txt)return;
  navigator.clipboard.writeText(txt).then(()=>{
    msg.classList.add("copy-flash");
    setTimeout(()=>msg.classList.remove("copy-flash"),500);
  }).catch(()=>{});
}

// Notifications
let notifPermission=(typeof Notification!=="undefined")?Notification.permission:"denied";
function requestNotifPermission(){
  if(typeof Notification==="undefined")return;
  if(notifPermission==="default"){
    Notification.requestPermission().then(p=>{notifPermission=p}).catch(()=>{});
  }
}
function notifyDone(resultText){
  if(typeof Notification==="undefined")return;
  if(notifPermission!=="granted")return;
  try{
    const n=new Notification("llmTerminal — response ready",{
      body:(resultText||"").slice(0,120),
      icon:"/favicon.ico",
      tag:"llmt-done",
    });
    n.onclick=()=>{window.focus();n.close()};
  }catch{}
}

// Voice note recording via MediaRecorder (Telegram-style)
let voiceRec=null, voiceActive=false, voiceChunks=[], voiceStartTime=0, voiceTimerInterval=null;
// (voice-input fns moved to app-voice.js)
function updateSendButton(){
  if(sendBtn){sendBtn.disabled=busy||!isSynced}
}

inp.addEventListener("input",()=>{
  autoResizeInput(inp);
  localStorage.setItem("llmt_draft",inp.value);
});
// Restore draft on load
try{const d=localStorage.getItem("llmt_draft");if(d){inp.value=d;autoResizeInput(inp);}}catch{}
// Phase 1: restore selection, sidebar/drawer state, file filter, search query
try{
  const sel=JSON.parse(localStorage.getItem("llmt_draft_sel")||"null");
  if(sel&&typeof sel.s==="number"){inp.setSelectionRange(sel.s,sel.e||sel.s)}
}catch{}
try{
  const isMobile=window.innerWidth<=768;
  if(!isMobile&&localStorage.getItem("llmt_drawer_open")==="true"){
    document.getElementById("drawer").classList.remove("hidden");
  }
  if(!isMobile&&localStorage.getItem("llmt_sidebar_open")==="true"){
    document.getElementById("sidebar").classList.add("show");
  }
  const ff=localStorage.getItem("llmt_file_filter");
  if(ff){fileFilter=ff}
  const sq=localStorage.getItem("llmt_drawer_search");
  if(sq){const el=document.getElementById("drawerSearch");if(el)el.value=sq}
}catch{}
// Save input selection on cursor move
document.addEventListener("selectionchange",()=>{if(document.activeElement===inp)saveInputSelection()});
inp.addEventListener("click",saveInputSelection);
inp.addEventListener("keyup",saveInputSelection);
// Save chat scroll position
chat.addEventListener("scroll",()=>{updateStickyFromScroll();saveChatScroll();});
// Save drawer search query
const dsEl=document.getElementById("drawerSearch");
if(dsEl)dsEl.addEventListener("input",()=>{try{localStorage.setItem("llmt_drawer_search",dsEl.value)}catch{}});
// Chat search listeners
const chatSearchInput=document.getElementById("chatSearchInput");
if(chatSearchInput){
  chatSearchInput.addEventListener("input",runChatSearch);
  chatSearchInput.addEventListener("keydown",(e)=>{if(e.key==="Escape"){toggleChatSearch();inp.focus()}});
}
document.addEventListener("keydown",(e)=>{
  if((e.key==="f"||e.key==="F")&&(e.metaKey||e.ctrlKey)){
    e.preventDefault();
    const bar=document.getElementById("chatSearchBar");
    if(bar.classList.contains("hidden"))toggleChatSearch();
    else document.getElementById("chatSearchInput").focus();
    return;
  }
  // Enter when audio is selected → play the queue. Bypassed when typing or
  // when modifier keys are involved (Cmd-Enter, Shift-Enter, etc.).
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    const t = e.target;
    const isTyping = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    if (!isTyping && selectedPreviewIds.size && _selectedAudioQueue().length) {
      e.preventDefault();
      playSelectedAudio();
      return;
    }
  }
  // Voice note keyboard: Space to record/send, Escape to cancel
  const ae=document.activeElement;
  const inText=ae&&(ae.tagName==="INPUT"||ae.tagName==="TEXTAREA"||ae.isContentEditable);
  if(e.key===" "&&!voiceActive&&!inText&&!e.metaKey&&!e.ctrlKey){
    e.preventDefault();toggleVoiceInput();return;
  }
  if(e.key===" "&&voiceActive){
    e.preventDefault();stopVoiceRecording();return;
  }
  if(e.key==="Escape"&&voiceActive){
    e.preventDefault();cancelVoiceRecording();return;
  }
});
inp.addEventListener("keydown",(e)=>{
  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();return}
  if(e.key==="ArrowUp"){
    // Only intercept if cursor is on first line (no newline before caret)
    const before=inp.value.substring(0,inp.selectionStart);
    if(before.indexOf("\n")!==-1)return; // multi-line edit, let cursor move
    if(sentHistory.length===0)return;
    if(historyIdx===-1) currentDraft=inp.value; // save draft on first up
    if(historyIdx<sentHistory.length-1){
      historyIdx++;
      setInputFromHistory(sentHistory[historyIdx]);
    }
    e.preventDefault();
    return;
  }
  if(e.key==="ArrowDown"){
    if(historyIdx<0)return; // not in history mode
    // Only intercept if cursor is on last line
    const after=inp.value.substring(inp.selectionEnd);
    if(after.indexOf("\n")!==-1)return;
    historyIdx--;
    if(historyIdx<0){
      setInputFromHistory(currentDraft);
      currentDraft="";
    }else{
      setInputFromHistory(sentHistory[historyIdx]);
    }
    e.preventDefault();
    return;
  }
  if(e.key==="Escape"&&historyIdx>=0){
    historyIdx=-1;
    setInputFromHistory(currentDraft);
    currentDraft="";
    e.preventDefault();
  }
});

// -- Swipe gestures removed: conflicted with iOS back/forward and text selection.
//    Use the hamburger (☰) and Files buttons to open drawers.
// Bubble context menu (long-press) - Copy + Read aloud via /api/tts (fallback: SpeechSynthesis)
function bubbleText(el){
  const src = el.classList.contains("bubble") ? el : (el.querySelector(".bubble") || el);
  const clone = src.cloneNode(true);
  clone.querySelectorAll("img, button, .perm-label, .perm-tool, .perm-detail, .perm-actions, .api-err-actions").forEach(n=>n.remove());
  return (clone.innerText || clone.textContent || "").trim();
}
function closeBubbleMenu(){document.querySelectorAll(".bubble-menu").forEach(m=>m.remove())}
function showBubbleMenu(ev, el){
  ev.preventDefault();
  closeBubbleMenu();
  const text = bubbleText(el);
  if(!text) return;
  const menu = mk("div","bubble-menu");
  const cBtn = mk("button","bm-btn"); cBtn.dataset.act="copy"; cBtn.textContent="\u{1F4CB} Copy text";
  const tBtn = mk("button","bm-btn"); tBtn.dataset.act="tts";  tBtn.textContent="\u{1F50A} Read aloud";
  menu.appendChild(cBtn); menu.appendChild(tBtn);
  document.body.appendChild(menu);
  const px = (ev.touches && ev.touches[0] ? ev.touches[0].clientX : (ev.clientX||window.innerWidth/2));
  const py = (ev.touches && ev.touches[0] ? ev.touches[0].clientY : (ev.clientY||window.innerHeight/2));
  const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 96;
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = Math.min(Math.max(8, px - mw/2), vw - mw - 8);
  const top  = py - mh - 10 > 8 ? py - mh - 10 : Math.min(py + 10, vh - mh - 8);
  menu.style.left = left + "px";
  menu.style.top  = top  + "px";
  menu.onclick = async (e)=>{
    const btn = e.target.closest("[data-act]"); if(!btn) return;
    e.stopPropagation();
    if(btn.dataset.act === "copy"){
      try{ await navigator.clipboard.writeText(text); btn.textContent = "\u2713 Copied"; }
      catch(err){
        try{ const ta=document.createElement("textarea"); ta.value=text; ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); btn.textContent="\u2713 Copied"; }
        catch(_){ btn.textContent = "Copy failed"; }
      }
      setTimeout(closeBubbleMenu, 700);
    } else if(btn.dataset.act === "tts"){
      // Call sync within the click to preserve iOS user-gesture for audio.
      playTts(text);
      closeBubbleMenu();
    }
  };
  setTimeout(()=>{
    const closer=(e)=>{ if(!e.target.closest(".bubble-menu")) closeBubbleMenu(); };
    document.addEventListener("click", closer, {once:true});
    document.addEventListener("touchstart", closer, {once:true, passive:true});
  }, 50);
}

// ── Task Board (orchestrator proxy) ──
let taskCache=[], taskFilter="actionable";
// (task-board fns moved to app-tasks.js)
// Manual long-press detection (iOS Safari often suppresses contextmenu on selectable text)
(function(){
  let timer=null, sx=0, sy=0, targetEl=null;
  const DUR=500, MOVE=10;
  chat.addEventListener("touchstart",(e)=>{
    if(e.touches.length!==1) return;
    const t=e.target.closest(".msg.user, .msg.assistant .bubble, .msg.assistant");
    if(!t) return;
    sx=e.touches[0].clientX; sy=e.touches[0].clientY; targetEl=t;
    if(timer) clearTimeout(timer);
    timer=setTimeout(()=>{
      timer=null;
      const fakeEv={preventDefault:()=>{},touches:[{clientX:sx,clientY:sy}],clientX:sx,clientY:sy};
      showBubbleMenu(fakeEv, targetEl);
    }, DUR);
  },{passive:true});
  chat.addEventListener("touchmove",(e)=>{
    if(!timer) return;
    const dx=e.touches[0].clientX-sx, dy=e.touches[0].clientY-sy;
    if(Math.hypot(dx,dy)>MOVE){ clearTimeout(timer); timer=null; }
  },{passive:true});
  const cancel=()=>{ if(timer){clearTimeout(timer); timer=null;} };
  chat.addEventListener("touchend",cancel,{passive:true});
  chat.addEventListener("touchcancel",cancel,{passive:true});
})();

chat.addEventListener("contextmenu",(e)=>{
  const el = e.target.closest(".msg.user, .msg.assistant .bubble, .msg.assistant");
  if(!el) return;
  showBubbleMenu(e, el);
});



init();
// Render persisted file-attachment tray on load (if any survived from a prior session)
try { renderSelectedTray(); } catch {}

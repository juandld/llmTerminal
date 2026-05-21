let ws=null, session=null, busy=false, historyOffset=0, grantedPerms=new Set();
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
const modelSel = document.getElementById("modelSel");
// Populate from localStorage default early so UI matches before WS arrives.
try { const saved = localStorage.getItem("llmt_default_model") || ""; if (modelSel) modelSel.value = saved; } catch {}
function applyModelDirty() { if (modelSel) modelSel.classList.toggle("dirty", !!modelSel.value); }
applyModelDirty();
if (modelSel) {
  modelSel.addEventListener("change", () => {
    const m = modelSel.value || "";
    try { localStorage.setItem("llmt_default_model", m); } catch {}
    applyModelDirty();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "set_model", model: m }));
    }
    // Sync mobile model selector
    const omSel = document.getElementById("omModelSel");
    if (omSel) omSel.value = m;
  });
}
// Mobile overflow model selector — sync back to desktop
const omModelSel = document.getElementById("omModelSel");
if (omModelSel) {
  try { omModelSel.value = localStorage.getItem("llmt_default_model") || ""; } catch {}
  omModelSel.addEventListener("change", () => {
    const m = omModelSel.value || "";
    if (modelSel) { modelSel.value = m; modelSel.dispatchEvent(new Event("change")); }
  });
}

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
  // "working" rolls of activity bumps lastActive on each tool_use/tool_result the
  // CLI streams. If we've gone >5 min without any bump, the claude process
  // almost certainly died mid-run — surface as "stalled" so it stops looking
  // like it's still thinking.
  if (role === "user" || role === "tool_activity" || role === "tool_result" || role === "permission_granted") {
    return ageMin > 5 ? "stalled" : "working";
  }
  // Responded: if you've opened the session after the assistant's last message
  // and let it sit ≥30 min, it auto-flips to done. Otherwise stays "responded"
  // until the 3-day fallback. Reply detection bumps lastActive past lastViewed,
  // pulling it back to a needs-attention state automatically.
  if (role === "assistant") {
    const seenAfterReply = (s.lastViewed || 0) > (s.lastActive || 0);
    if (seenAfterReply && ageMin > 30) return "done";
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
  blocked:   "❗",       // ❗
  decision:  "⚡",       // ⚡
  stalled:   "⚠️",       // process exited mid-run, no final response
  responded: "✓",       // ✓
  working:   "⏳",       // ⏳
  done:      "✅",       // ✅
};
const STATE_PRIORITY = { blocked: 0, decision: 1, stalled: 1.5, responded: 2, working: 3, done: 4 };


// Round-robin through sessions that need attention. Tap = jump to next.
function attentionSessionsList() {
  return (_allSessions || [])
    .filter(s => !s.archived)
    .map(s => ({ s, st: computeSessionState(s) }))
    .filter(({st}) => st === "blocked" || st === "decision" || st === "stalled" || st === "responded")
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

function makeSbItem(x, currentProject) {
  const d = document.createElement("div");
  // 5-state triage class
  const state = computeSessionState(x);
  const stateClass = state ? "state-" + state : "";
  d.className = "sb-item " + stateClass + (session?.id === x.id ? " active" : "") + (x.archived ? " sb-archived" : "");
  d.dataset.state = state;
  const ti = mk("div", "ti");
  const row1 = mk("div", "row1");
  if (state && STATE_ICONS[state]) {
    const ic = mk("span", "sb-ic sb-ic-" + state);
    ic.textContent = STATE_ICONS[state];
    row1.appendChild(ic);
  }
  const ttl = mk("div", "ttl"); ttl.textContent = x.title || "(untitled)";
  row1.appendChild(ttl);
  ti.appendChild(row1);
  const row2 = mk("div", "row2");
  if (currentProject === "ALL" && x.project) {
    const pj = mk("span", "pj"); pj.textContent = x.project; row2.appendChild(pj);
  }
  const when = mk("span", ""); when.textContent = relativeTime(x.lastActive);
  row2.appendChild(when);
  if (x.messageCount) {
    const mc = mk("span", ""); mc.textContent = "\u00b7 " + x.messageCount + " msg"; row2.appendChild(mc);
  }
  ti.appendChild(row2);
  // Activity snippet — what's happening in this chat
  if (x.lastSnippet) {
    const snip = mk("div", "sb-snippet");
    snip.textContent = x.lastSnippet;
    ti.appendChild(snip);
  }
  d.appendChild(ti);
  // \u2713 button: mark a "responded" or "stalled" session done without further fuss.
  // Hidden for blocked/decision/working/done (those need real action, not dismissal).
  if (state === "responded" || state === "stalled") {
    const okb = mk("button", "sb-done-btn"); okb.textContent = "\u2713";
    okb.title = state === "stalled" ? "Dismiss (claude process exited without responding)" : "Mark done";
    okb.onclick = (e) => { e.stopPropagation(); markSessionDone(x.id); };
    d.appendChild(okb);
  }
  const xb = mk("button", "x"); xb.textContent = "\u00d7";
  d.appendChild(xb);
  ti.onclick = () => resumeSession(x);
  xb.onclick = (e) => { e.stopPropagation(); delSession(x.id); };
  let pressTimer = null;
  d.addEventListener("touchstart", (e) => {
    pressTimer = setTimeout(() => { showSessionInfo(x, d); pressTimer = null; }, 500);
  }, { passive: true });
  d.addEventListener("touchend", () => { if (pressTimer) clearTimeout(pressTimer); });
  d.addEventListener("touchmove", () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
  d.addEventListener("contextmenu", (e) => { e.preventDefault(); showSessionInfo(x, d); });
  d.title = (x.title || "") + "\n" + (x.project || "") + " \u00b7 " + (x.messageCount || 0) + " msgs \u00b7 " + relativeTime(x.lastActive) + (x.archived ? " \u00b7 archived" : "");
  return d;
}
function renderBucketed(items, parent, currentProject) {
  const buckets = {};
  items.forEach(x => { const b = recencyBucket(x.lastActive); (buckets[b] = buckets[b] || []).push(x); });
  BUCKET_ORDER.forEach(bname => {
    if (!buckets[bname]) return;
    const bh = mk("div", "sb-bucket"); bh.textContent = bname;
    parent.appendChild(bh);
    buckets[bname].forEach(x => parent.appendChild(makeSbItem(x, currentProject)));
  });
}
function renderProjectGroup(projectName, items, parent, forceExpand) {
  let collapsed = false;
  if (forceExpand) {
    collapsed = false;
  } else if (_collapsedProjects.has(projectName)) {
    collapsed = true;
  } else if (!_collapsedProjects.has("__expanded_" + projectName)) {
    const newestTs = Math.max(...items.map(x => x.lastActive || 0));
    collapsed = !RECENT_BUCKETS.has(recencyBucket(newestTs));
  }
  const header = mk("div", "sb-group" + (collapsed ? " collapsed" : ""));
  const left = mk("span", "gname");
  const chev = mk("span", "chev"); chev.textContent = "\u25BC";
  left.appendChild(chev);
  left.appendChild(document.createTextNode(" " + projectName));
  const count = mk("span", "gcount"); count.textContent = items.length ? String(items.length) : "\u2014";
  header.appendChild(left);
  header.appendChild(count);
  const content = mk("div", "sb-project-content");
  renderBucketed(items, content, "ALL");
  header.onclick = () => {
    const isNowCollapsed = !header.classList.contains("collapsed");
    header.classList.toggle("collapsed");
    if (isNowCollapsed) {
      _collapsedProjects.add(projectName);
      _collapsedProjects.delete("__expanded_" + projectName);
    } else {
      _collapsedProjects.delete(projectName);
      _collapsedProjects.add("__expanded_" + projectName);
    }
    _persistCollapsed();
    // Tapping a project header sets it as the active context — the
    // "+ New in X" button reflects this. Strip "(archived)" suffix the
    // archive renderer adds so the button gets a clean project name.
    const cleanProj = projectName.replace(/ \(archived\)$/, "");
    if (_availableProjects.includes(cleanProj)) {
      try { localStorage.setItem("llmt_project", cleanProj); } catch {}
      _updateNewSessionLabel();
    }
  };
  parent.appendChild(header);
  parent.appendChild(content);
}
async function loadSessions() {
  _allSessions = await fetch(apiUrl("/api/sessions?project=ALL")).then(r => r.json());
  // Re-apply optimistic updates that may have raced the fetch.
  _applyPendingToList(_allSessions);
  _renderSidebar();
}
function _renderSidebar() {
  _updateNewSessionLabel();
  sbList.innerHTML = "";
  const qRaw = (_searchQuery || "").trim();
  const q = qRaw.toLowerCase();
  const contentHit = (x) => _contentMatchIds && _contentMatchIds.has(x.id);
  const matches = (x) =>
    !q ||
    (x.title   || "").toLowerCase().includes(q) ||
    (x.project || "").toLowerCase().includes(q) ||
    (x.lastSnippet || "").toLowerCase().includes(q) ||
    contentHit(x);
  const filtered = _allSessions.filter(matches);
  const active = filtered.filter(x => !x.archived);
  const archived = filtered.filter(x => x.archived);
  if (!filtered.length && q) {
    const empty = mk("div", "sb-empty");
    const stillRunning = _contentMatchQuery !== qRaw;
    empty.textContent = stillRunning
      ? "Searching message bodies for \"" + qRaw + "\"…"
      : "No sessions match \"" + qRaw + "\"";
    sbList.appendChild(empty);
    return;
  }

  // Partition by state into three groups
  const attentionItems = [];  // blocked, decision — top section
  const progressItems  = [];  // responded, working — per-project groups
  const doneItems      = [];  // done — collapsed at bottom
  active.forEach(s => {
    const st = computeSessionState(s);
    if (st === "blocked" || st === "decision" || st === "stalled") attentionItems.push(s);
    else if (st === "done") doneItems.push(s);
    else progressItems.push(s);
  });

  // ─── Section 1: NEEDS YOU (flat, state-priority sorted) ───
  if (attentionItems.length) {
    attentionItems.sort((a, b) => {
      const sa = computeSessionState(a), sb = computeSessionState(b);
      if (STATE_PRIORITY[sa] !== STATE_PRIORITY[sb]) return STATE_PRIORITY[sa] - STATE_PRIORITY[sb];
      return (b.lastActive || 0) - (a.lastActive || 0);
    });
    const h = mk("div", "sb-section-header sb-needs-you");
    h.textContent = "\u{1F6A8} NEEDS YOU (" + attentionItems.length + ")";
    sbList.appendChild(h);
    attentionItems.forEach(x => sbList.appendChild(makeSbItem(x, "ALL")));
  }

  // ─── Section 2: in-progress chats grouped by project ───
  const byProj = {};
  progressItems.forEach(x => { (byProj[x.project] = byProj[x.project] || []).push(x); });
  const seedKeys = q ? Object.keys(byProj) : Array.from(new Set([..._availableProjects, ...Object.keys(byProj)]));
  const projOrder = seedKeys.sort((a, b) => {
    const aMax = Math.max(...((byProj[a] || []).map(x => x.lastActive || 0)), 0);
    const bMax = Math.max(...((byProj[b] || []).map(x => x.lastActive || 0)), 0);
    if (aMax !== bMax) return bMax - aMax;
    return a.localeCompare(b);
  });
  const forceExpand = !!q;
  projOrder.forEach(pname => renderProjectGroup(pname, byProj[pname] || [], sbList, forceExpand));

  // ─── Section 3: DONE (collapsed by default, with summary + bulk archive) ───
  if (doneItems.length) renderDoneSection(doneItems);

  // ─── Section 4: archived (existing behavior preserved) ───
  if (archived.length) {
    const toggle = mk("div", "sb-archive-toggle");
    toggle.textContent = (_showArchived ? "\u25BC Hide" : "\u25B6 Show") + " archived (" + archived.length + ")";
    toggle.onclick = () => { _showArchived = !_showArchived; _renderSidebar(); };
    sbList.appendChild(toggle);
    if (_showArchived) {
      const wrap = mk("div", "");
      const byProjA = {};
      archived.forEach(x => { (byProjA[x.project] = byProjA[x.project] || []).push(x); });
      Object.keys(byProjA).sort().forEach(p => renderProjectGroup(p + " (archived)", byProjA[p], wrap, forceExpand));
      sbList.appendChild(wrap);
    }
  }

  refreshAttentionCounter();
}

let _doneExpanded = false;
try { _doneExpanded = localStorage.getItem("llmt_done_expanded") === "1"; } catch {}

function renderDoneSection(items) {
  items.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  const now = Date.now();
  const DAY = 86400000;
  const today = items.filter(x => now - (x.lastActive || 0) < DAY).length;
  const older = items.length - today;
  const archivable = items.filter(x => now - (x.manualDone || x.lastActive || 0) > 7 * DAY).length;

  const wrap = mk("div", "sb-done-section");
  const header = mk("div", "sb-section-header sb-done-header" + (_doneExpanded ? " open" : ""));
  const chevron = mk("span", "sb-done-toggle");
  chevron.textContent = _doneExpanded ? "\u25BC" : "\u25B6";
  const label = mk("span", "sb-done-label");
  const summary = "\u2705 Done (" + items.length
    + (today ? " · " + today + " today" : "")
    + (older ? " · " + older + " older" : "")
    + ")";
  label.textContent = summary;
  header.appendChild(chevron);
  header.appendChild(label);

  if (archivable) {
    const archBtn = mk("button", "sb-done-archive-btn");
    archBtn.textContent = "Archive " + archivable + " (>7d)";
    archBtn.onclick = (e) => {
      e.stopPropagation();
      if (!confirm("Archive " + archivable + " done chats older than 7 days?")) return;
      fetch(apiUrl("/api/sessions/bulk-archive-done"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ olderThanDays: 7 }),
      }).then(r => r.json()).then(() => loadSessions()).catch(()=>{});
    };
    header.appendChild(archBtn);
  }

  wrap.appendChild(header);
  const list = mk("div", "sb-done-list");
  if (!_doneExpanded) list.style.display = "none";
  items.forEach(x => list.appendChild(makeSbItem(x, "ALL")));
  wrap.appendChild(list);

  header.onclick = (e) => {
    if (e.target.classList.contains("sb-done-archive-btn")) return;
    _doneExpanded = !_doneExpanded;
    try { localStorage.setItem("llmt_done_expanded", _doneExpanded ? "1" : "0"); } catch {}
    list.style.display = _doneExpanded ? "" : "none";
    chevron.textContent = _doneExpanded ? "\u25BC" : "\u25B6";
    header.classList.toggle("open", _doneExpanded);
  };
  sbList.appendChild(wrap);
}


function _teardownAndConnect(project, sessionId){
  if(ws) ws.close();
  chat.innerHTML=""; session=null; ws=null; busy=false; removeThinking();
  try { localStorage.setItem("llmt_project", project); } catch {}
  setBusy(false);
  connect(project, sessionId);
  _updateNewSessionLabel();
}
function newSession(project){
  // Always show picker if no project given so the user picks explicitly
  // (avoids "session landed in the wrong project" surprises).
  if (!project || project === "ALL") {
    openNewSessionPicker();
    return;
  }
  localStorage.removeItem("llmt_session"); location.hash="";
  _teardownAndConnect(project, null);
}
function openNewSessionPicker(){
  const overlay = mk("div", "sb-picker-overlay");
  const sheet = mk("div", "sb-picker");
  const h = mk("h2", ""); h.textContent = "Start a new session in\u2026";
  sheet.appendChild(h);
  let suggested = "";
  if (session && session.project) suggested = session.project;
  else { try { suggested = localStorage.getItem("llmt_project") || ""; } catch {} }
  const ordered = _availableProjects.slice().sort((a, b) => {
    if (a === suggested) return -1;
    if (b === suggested) return 1;
    return a.localeCompare(b);
  });
  ordered.forEach(p => {
    const chip = mk("button", "pchip" + (p === suggested ? " recent" : ""));
    const name = mk("span", ""); name.textContent = p;
    chip.appendChild(name);
    if (p === suggested) {
      const meta = mk("span", "pchip-meta");
      meta.textContent = (session && session.project === p) ? "current chat" : "last used";
      chip.appendChild(meta);
    }
    chip.onclick = () => { overlay.remove(); newSession(p); };
    sheet.appendChild(chip);
  });
  const cancel = mk("button", "cancel"); cancel.textContent = "Cancel";
  cancel.onclick = () => overlay.remove();
  sheet.appendChild(cancel);
  overlay.appendChild(sheet);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}
function resumeSession(s){
  _teardownAndConnect(s.project, s.id);
}
async function delSession(id){
  await fetch(apiUrl("/api/sessions/"+id),{method:"DELETE"});
  if(session?.id===id){if(ws)ws.close();chat.innerHTML="";session=null;}
  loadSessions();
}

function connect(project,sessionId){
  const proto=location.protocol==="https:"?"wss":"ws";
  let url=proto+"://"+location.host+BASE+"/ws?project="+project;
  if(sessionId) url+="&session="+sessionId;
  ws=new WebSocket(url);
  setStatus("connecting","thinking");
  badge.textContent=project;

  ws.onopen=()=>{
    setStatus("syncing...","thinking");
    lastServerMsgTs=Date.now();
    isSynced=false;
    // Outbox will be flushed when `ready` arrives
  };
  ws.onmessage=(e)=>{
    lastServerMsgTs=Date.now();
    const msg=JSON.parse(e.data);
    switch(msg.type){
      case "ping":
        try{ws.send(JSON.stringify({type:"pong",ts:msg.ts}))}catch{}
        break;
      case "ack":
        if(msg.client_id){outbox=outbox.filter(m=>m.id!==msg.client_id);saveOutbox()}
        break;
      case "ready":
        isSynced=true;
        setStatus("connected","active");
        flushOutbox();
        updateSendButton();
        break;
      case "api_error":
        removeThinking();
        addApiErrorCard(msg);
        setBusy(false);
        setStatus("error","");
        break;
      case "session_summary":
        renderSummary(msg.data);
        break;
      case "session":
        session=msg.session;
        localStorage.setItem("llmt_session", session.id);
        localStorage.setItem("llmt_project", session.project);
        location.hash = session.id;
        markSessionViewed(session.id);
        loadSessions();
        refreshPreviews(false);
        startBrowserPoll();
        if (modelSel) { modelSel.value = session.model || ""; applyModelDirty(); }
        break;
      case "history":
        // Diff-based rendering: only append messages newer than what's already on screen
        removeThinking();
        historyOffset = msg.offset || 0;
        // Ensure a load-more bar if needed (don't duplicate)
        if(historyOffset > 0 && !chat.querySelector(".load-more-bar")){
          const bar=mk("div","load-more-bar");
          bar.textContent="Load earlier messages";
          bar.onclick=()=>loadMore();
          chat.prepend(bar);
        }
        // First reconnect ever? Compute lastRenderedTs from existing DOM (in case client was reloaded mid-session)
        if(lastRenderedTs===0){
          const stamped=chat.querySelectorAll("[data-ts]");
          stamped.forEach(el=>{
            const t=parseInt(el.dataset.ts||"0",10);
            if(t>lastRenderedTs)lastRenderedTs=t;
          });
        }
        // If chat is completely empty, fall back to bulk render (fresh session)
        const chatIsEmpty = !chat.querySelector(".msg");
        let newestTs=lastRenderedTs;
        (msg.messages||[]).forEach(m=>{
          const ts=m.ts||0;
          if(!chatIsEmpty && ts && ts<=lastRenderedTs) return; // already rendered
          if(m.role==="user"&&m.source!=="voice-note") addUser(m.text);
          else if(m.role==="question") addQuestion(m.text);
          else if(m.role==="permission_denied") addPermissionCardFromHistory({tool_name:m.tool_name,tool_input:m.tool_input,message:m.message});
          else if(m.role==="assistant") addAssistant(m.text);
          else if(m.role==="tool_activity") addToolActivityLine(m.tool_name, m.summary);
          else if(m.role==="email_draft") addEmailDraft(m);
          // Tag the newly-appended element with ts for future diffing
          if(ts){
            const last=chat.lastElementChild;
            if(last && !last.dataset.ts) last.dataset.ts=ts;
            if(ts>newestTs)newestTs=ts;
          }
        });
        lastRenderedTs=newestTs;
        setBusy(false);
        // Restore scroll only on fresh rebuild
        if(chatIsEmpty) setTimeout(restoreChatScroll,0);
        break;
      case "history_prepend":
        const oldH=chat.scrollHeight;
        const bar=chat.querySelector(".load-more-bar");
        if(bar) bar.remove();
        historyOffset = msg.offset || 0;
        if(historyOffset > 0){
          const nb=mk("div","load-more-bar");
          nb.textContent="Load earlier messages";
          nb.onclick=()=>loadMore();
          chat.prepend(nb);
        }
        const frag=document.createDocumentFragment();
        (msg.messages||[]).forEach(m=>{
          if(m.role==="permission_denied"){
            // Skip in prepend — already resolved
            return;
          }
          if(m.role==="tool_activity"){
            const line=mk("div","msg tool-activity-line");
            line.textContent="\u25B8 "+(m.tool_name||"?")+(m.summary?": "+m.summary:"");
            frag.appendChild(line);
            return;
          }
          const d=mk("div","msg "+(m.role==="user"?"user":m.role==="question"?"question":"assistant"));
          if(m.role==="user") d.appendChild(document.createTextNode(m.text));
          else if(m.role==="question"){const l=mk("div","q-label");l.textContent="Question";const b=mk("div","q-text");b.innerHTML=fmt(m.text);d.appendChild(l);d.appendChild(b);}
          else{const b=mk("div","bubble");b.innerHTML=fmt(m.text);d.appendChild(b);}
          frag.appendChild(d);
        });
        const anchor=chat.querySelector(".load-more-bar");
        if(anchor) anchor.after(frag); else chat.prepend(frag);
        chat.scrollTop=chat.scrollHeight-oldH;
        break;
      case "status":
        if(msg.status==="connected") setStatus("syncing...","thinking");
        break;
      case "thinking":
        showThinking();
        setStatus("thinking...","thinking");
        break;
      case "text":
        // Claude's response text — show in bubble
        removeThinking();
        addAssistant(msg.text, {live:true});
        break;
      case "tool_use":
        if(msg.name==="AskUserQuestion"){
          removeThinking();
          const input = msg.input||{};
          const q = input.questions ? JSON.stringify(input) : (input.question || input.text || JSON.stringify(input));
          addQuestion(q);
        } else {
          addTool(msg.name, JSON.stringify(msg.input||{},null,2).slice(0,300));
        }
        break;
      case "tool_result":
        // Optionally show tool results
        break;
      case "email_draft":
        removeThinking();
        addEmailDraft(msg);
        break;
            case "queued":
        // Server confirmed it queued our prompt while busy. Treat as ack so outbox drops it.
        if (msg.client_id) {
          outbox = outbox.filter(x => x.id !== msg.client_id);
          saveOutbox();
        }
        _serverQueueDepth = msg.queueDepth || 0;
        renderQueueCount();
        break;
      case "queue_state":
        _serverQueueDepth = msg.queueDepth || 0;
        renderQueueCount();
        break;
      case "queued_prompt_firing":
        // Voice notes already have a card in chat — don't duplicate as text
        if(msg.source!=="voice-note") addUser(msg.text || "", null);
        _serverQueueDepth = Math.max(0, (_serverQueueDepth || 0) - 1);
        renderQueueCount();
        setBusy(true);
        break;
      case "permission_denied":
        addPermissionCard(msg);
        break;
      case "model_set":
        if (modelSel) {
          modelSel.value = msg.model || "";
          applyModelDirty();
        }
        break;
            case "permission_granted":
        if(msg.permission) grantedPerms.add(msg.permission);
        break;
      case "title_updated":
        // Refresh the sidebar so the new title shows up.
        try { loadSessions(); } catch {}
        break;
      case "permissions_state":
        grantedPerms=new Set(msg.permissions||[]);
        break;
      case "interrupted":
        setBusy(false);
        removeThinking();
        addSystemNote("Stopped.");
        break;
            case "done":
        removeThinking();
        if(msg.result && !document.querySelector(".msg.assistant:last-child")){
          addAssistant(msg.result, {live:true});
        }
        refreshPreviews(true);
        // Check if response mentions voiceover/segments — auto-load audio review
        if(msg.result) checkForAudioReview(msg.result);
        // Browser notification if tab is backgrounded
        if(msg.result && document.hidden) notifyDone(msg.result);
        setBusy(false);
        setStatus("ready","active");
        break;
      case "idle":
        setBusy(false);
        setStatus("ready","active");
        break;
      case "error":
        removeThinking();
        addError(msg.message);
        setBusy(false);
        setStatus("error","");
        break;
      case "exit":
        addSystem("Session ended");
        setBusy(false);
        break;
    }
  };
  ws.onclose=()=>{
    setStatus("reconnecting...","thinking"); ws=null;
    // Auto-reconnect — session history will sync on reconnect
    setTimeout(()=>{if(!ws&&session) connect(session.project,session.id)},2000);
  };
  ws.onerror=()=>setStatus("error","");
  // Staleness watcher: if server hasn't sent anything for 25s show slow, 45s force reconnect
  if(staleTimer) clearInterval(staleTimer);
  staleTimer=setInterval(()=>{
    if(!ws||ws.readyState!==1) return;
    const age=Date.now()-lastServerMsgTs;
    if(age>45000){console.log("[heartbeat] stale>45s, forcing reconnect");try{ws.close()}catch{}}
    else if(age>25000){setStatus("slow...","thinking")}
  },5000);
}

function send(){
  const text=inp.value.trim();
  if(!text&&pendingImages.length===0) return;
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
    messageQueue.push({text,images,previews});
    addQueued(text);
    inp.value=""; inp.style.height="44px"; localStorage.removeItem("llmt_draft");
    clearImages();
    renderQueueCount();
    return;
  }
  const prompt=text||"Describe the attached image(s).";
  const images=pendingImages.map(i=>({data:i.data,mimeType:i.mimeType}));
  const previews=pendingImages.map(i=>i.preview);

  if(!ws||ws.readyState!==1){
    const clientId=genMsgId();
    outbox.push({id:clientId,text,images,ts:Date.now()});saveOutbox();
    connect(_defaultProject(),session?.id);
    ws.onopen=()=>{
      setStatus("connected","active");lastServerMsgTs=Date.now();
      ws.send(JSON.stringify({type:"prompt",client_id:clientId,text:prompt,images}));
      setBusy(true);
    };
    addUser(text,previews); inp.value=""; inp.style.height="44px"; clearImages();
    return;
  }
  const clientId=genMsgId();
  outbox.push({id:clientId,text,images,ts:Date.now()});saveOutbox();
  ws.send(JSON.stringify({type:"prompt",client_id:clientId,text:prompt,images}));
  addUser(text,previews);
  // Tag live-rendered message so history replay doesn't duplicate
  const liveTs=Date.now();
  const last=chat.lastElementChild;
  if(last){last.dataset.ts=liveTs; lastRenderedTs=liveTs}
  inp.value=""; inp.style.height="44px"; inp.setAttribute("placeholder","Message Claude...");
  localStorage.removeItem("llmt_draft");
  localStorage.removeItem("llmt_draft_sel");
  clearImages();
  setBusy(true);
}

// ── Image handling ──
function addImage(file){
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
function addUser(text,imagePreviews){
  const d=mk("div","msg user");
  if(text) d.appendChild(document.createTextNode(text));
  if(imagePreviews){
    imagePreviews.forEach(src=>{const img=document.createElement("img");img.src=src;d.appendChild(img)});
  }
  chat.appendChild(d);scrollToBottomForce();
}
function addVoiceNoteUser(blob,duration,imagePreviews){
  const d=mk("div","msg user voice-note-msg");
  // Show attached images above the voice note
  if(imagePreviews&&imagePreviews.length){
    imagePreviews.forEach(src=>{const img=document.createElement("img");img.src=src;d.appendChild(img)});
  }
  const vn=mk("div","vn-bubble");
  // Title (populated after transcription)
  const title=mk("div","vn-title");title.textContent="Voice note";
  vn.appendChild(title);
  // Audio player
  const audio=document.createElement("audio");
  audio.src=URL.createObjectURL(blob);
  audio.preload="metadata";
  const playBtn=mk("button","vn-play");playBtn.textContent="▶";
  playBtn.onclick=()=>{
    if(audio.paused){audio.play();playBtn.textContent="⏸";}
    else{audio.pause();playBtn.textContent="▶";}
  };
  audio.onended=()=>{playBtn.textContent="▶";};
  audio.onpause=()=>{playBtn.textContent="▶";};
  audio.onplay=()=>{playBtn.textContent="⏸";};
  const wave=mk("div","vn-wave");
  for(let i=0;i<20;i++){const bar=mk("div","vn-bar");bar.style.height=Math.max(4,Math.random()*16)+"px";wave.appendChild(bar);}
  const dur=mk("span","vn-duration");
  dur.textContent=Math.floor(duration/60)+":"+(duration%60<10?"0":"")+(duration%60);
  audio.ontimeupdate=()=>{
    if(!audio.duration)return;
    const pct=audio.currentTime/audio.duration*100;
    wave.style.background=`linear-gradient(90deg,var(--accent) ${pct}%,var(--surface2) ${pct}%)`;
  };
  const row=mk("div","vn-row");
  row.appendChild(playBtn);row.appendChild(wave);row.appendChild(dur);
  vn.appendChild(row);
  // Status line — always visible, shows what's happening right now
  const status=mk("div","vn-status");status.textContent="Uploading…";
  vn.appendChild(status);
  // Collapsible transcript (fully hidden until ready)
  const toggle=mk("button","vn-toggle");
  toggle.textContent="Show transcript";
  const transcript=mk("div","vn-transcript");
  toggle.onclick=()=>{
    const open=transcript.classList.toggle("vn-open");
    toggle.textContent=open?"Hide transcript":"Show transcript";
  };
  vn.appendChild(toggle);
  vn.appendChild(transcript);
  d.appendChild(vn);
  chat.appendChild(d);scrollToBottomForce();
  return d;
}
function addAssistant(text, opts){
  const d=mk("div","msg assistant");
  const b=mk("div","bubble");
  b.innerHTML=fmt(text);
  // Speaker button for quick TTS access (inside bubble for correct positioning)
  const ttsBtn=mk("button","msg-tts-btn");
  ttsBtn.textContent="\u{1F50A}";
  ttsBtn.title="Read aloud";
  ttsBtn.onclick=(e)=>{ e.stopPropagation(); playTts(bubbleText(d)); };
  b.appendChild(ttsBtn);
  d.appendChild(b);
  const liveTs=Date.now();
  d.dataset.ts=liveTs;
  if(liveTs>lastRenderedTs)lastRenderedTs=liveTs;
  chat.appendChild(d);
  scrollToBottomIfSticky();
  if(opts && opts.live) preemptTts(text);
}
function addQuestion(text){
  const d=mk("div","msg question");
  // Try to parse structured questions (array of {question, header, options, multiSelect})
  let structured=null;
  try{
    const parsed=typeof text==="string"?JSON.parse(text):text;
    if(parsed.questions&&Array.isArray(parsed.questions)) structured=parsed.questions;
    else if(Array.isArray(parsed)) structured=parsed;
  }catch{}
  if(structured){
    const label=mk("div","q-label");label.textContent="Questions — pick options below";
    d.appendChild(label);
    const selections={};
    structured.forEach((q,qi)=>{
      const card=mk("div","q-card");
      if(q.header){const h=mk("div","q-header");h.textContent=q.header;card.appendChild(h);}
      const qt=mk("div","q-question");qt.textContent=q.question;card.appendChild(qt);
      if(q.options&&q.options.length){
        selections[qi]=q.multiSelect?new Set():null;
        const opts=mk("div","q-options");
        q.options.forEach((opt,oi)=>{
          const row=mk("div","q-opt-row");
          const btn=mk("button","q-opt");
          btn.textContent=opt.label+(opt.label.includes("Recommended")?"":"")||"Option "+(oi+1);
          if(opt.description){const desc=mk("div","q-opt-desc");desc.textContent=opt.description;row.appendChild(desc);}
          btn.onclick=()=>{
            if(q.multiSelect){
              if(selections[qi].has(opt.label)){selections[qi].delete(opt.label);btn.classList.remove("selected")}
              else{selections[qi].add(opt.label);btn.classList.add("selected")}
            }else{
              opts.querySelectorAll(".q-opt").forEach(b=>b.classList.remove("selected"));
              btn.classList.add("selected");
              selections[qi]=opt.label;
            }
          };
          row.prepend(btn);
          opts.appendChild(row);
        });
        card.appendChild(opts);
      }
      d.appendChild(card);
    });
    // Custom answer area per question — persist drafts across DOM rebuilds
    const headerSig = structured.map(q=>q.header||"").join("|");
    const draftKeyBase = "llmt_q_draft:" + (session?.id||"_") + ":" + headerSig + ":";
    structured.forEach((q,qi)=>{
      const cards=d.querySelectorAll(".q-card");
      if(cards[qi]){
        const custom=mk("div","q-custom-wrap");
        const toggle=mk("button","q-custom-toggle");toggle.textContent="Write custom answer";
        const ta=document.createElement("textarea");ta.className="q-custom-input";ta.placeholder="Type your own answer...";ta.rows=2;ta.style.display="none";
        const draftKey = draftKeyBase + qi;
        // Restore saved draft if present
        let savedDraft="";
        try{savedDraft=localStorage.getItem(draftKey)||"";}catch{}
        if(savedDraft){
          ta.value=savedDraft;
          ta.style.display="block";
          toggle.textContent="Hide custom answer";
          if(q.multiSelect){selections[qi]=new Set([savedDraft.trim()])}
          else{selections[qi]=savedDraft.trim()}
          cards[qi].querySelectorAll(".q-opt").forEach(b=>b.classList.remove("selected"));
        }
        toggle.onclick=()=>{
          const show=ta.style.display==="none";
          ta.style.display=show?"block":"none";
          toggle.textContent=show?"Hide custom answer":"Write custom answer";
          if(show)ta.focus();
        };
        ta.addEventListener("input",()=>{
          try{localStorage.setItem(draftKey, ta.value);}catch{}
          if(ta.value.trim()){
            if(q.multiSelect){selections[qi]=new Set([ta.value.trim()])}
            else{selections[qi]=ta.value.trim()}
            cards[qi].querySelectorAll(".q-opt").forEach(b=>b.classList.remove("selected"));
          }
        });
        custom.appendChild(toggle);custom.appendChild(ta);
        cards[qi].appendChild(custom);
      }
    });
    const submit=mk("button","q-submit");submit.textContent="Submit answers";
    submit.onclick=()=>{
      const answers=structured.map((q,qi)=>{
        const sel=selections[qi];
        const val=sel instanceof Set?[...sel].join(", "):(sel||"(no selection)");
        return(q.header||"Q"+(qi+1))+": "+val;
      }).join("\n");
      inp.value=answers;
      autoResizeInput(inp);
      // Clear saved drafts for this question set
      try{
        structured.forEach((q,qi)=>localStorage.removeItem(draftKeyBase+qi));
      }catch{}
      submit.disabled=true;submit.textContent="Submitted";
      inp.focus();
    };
    d.appendChild(submit);
  }else{
    const label=mk("div","q-label");label.textContent="Question — reply below";
    const body=mk("div","q-text");body.innerHTML=fmt(text);
    d.appendChild(label);d.appendChild(body);
  }
  chat.appendChild(d);
  scrollToBottomForce();
  if(window.innerWidth>768)inp.focus();
  inp.setAttribute("placeholder","Answer the question above...");
}

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
  const label=mk("div","perm-label");label.textContent="Permission Required";
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
  const label=mk("div","perm-label");label.textContent="Permission Required";
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

async function refreshPreviews(showNewInline){
  if(!session) return;
  try{
    const res=await fetch("/api/previews?session_id="+session.id).then(r=>r.json());
    const oldIds=new Set(sessionPreviews.map(p=>p.id));
    sessionPreviews=res.previews||[];
    renderDrawer();
    // Badge
    const badge=document.getElementById("filesBadge");
    if(sessionPreviews.length>0){badge.textContent=sessionPreviews.length;badge.style.display="";}
    else{badge.style.display="none";}
    syncMobileFilesBadge();
    // Show new previews inline in chat
    if(showNewInline){
      for(const p of sessionPreviews){
        if(!oldIds.has(p.id)&&!knownPreviewIds.has(p.id)){
          knownPreviewIds.add(p.id);
          addInlinePreview(p);
        }
      }
    }
    sessionPreviews.forEach(p=>knownPreviewIds.add(p.id));
  }catch{}
}

function addInlinePreview(p){
  const d=mk("div","file-preview");
  const icon=p.type==="email"?"✉️":p.type==="document"?"📄":"📎";
  let html='<div class="fp-header"><span class="fp-icon">'+icon+'</span><span class="fp-title">'+esc(p.title||"Untitled")+'</span><span class="fp-type">'+esc(p.type||"file")+'</span></div>';
  if(p.content){
    const c=p.content;
    if(c.from||c.to||c.subject){
      html+='<div class="fp-inline-meta">';
      if(c.from) html+='<div>From: <span>'+esc(c.from)+'</span></div>';
      if(c.to) html+='<div>To: <span>'+esc(Array.isArray(c.to)?c.to.join(", "):c.to)+'</span></div>';
      if(c.subject) html+='<div>Subject: <span>'+esc(c.subject)+'</span></div>';
      html+='</div>';
    }
    if(c.body_text) html+=fileBodyHtml(c.body_text,p.title,null);
  }
  if(p.attachments&&p.attachments.length){
    html+='<div class="fp-attachments">'+renderAttachmentsHtml(p.id,p.attachments)+'</div>';
  }
  html+='<div class="fp-review-actions" data-pid="'+p.id+'">';
  html+='<button class="fp-approve" onclick="reviewPreview(\''+p.id+'\',\'approve\')">Approve</button>';
  html+='<button class="fp-revise" onclick="reviewPreview(\''+p.id+'\',\'revise\')">Request changes</button>';
  html+='<button class="fp-copy" onclick="copyPreviewText(\''+p.id+'\')">Copy</button>';
  html+='</div>';
  d.innerHTML=html;
  chat.appendChild(d);
  scrollToBottomIfSticky();
}

function reviewPreview(id,action){
  if(action==="approve"){
    inp.value="I approve the file \""+((sessionPreviews.find(p=>p.id===id)||{}).title||id)+"\". Proceed.";
  } else {
    inp.value="Please revise the file \""+((sessionPreviews.find(p=>p.id===id)||{}).title||id)+"\": ";
    inp.focus();
    return;
  }
  localStorage.setItem("llmt_draft",inp.value);
  send();
}

function setFileFilter(f){
  fileFilter=f;
  try{localStorage.setItem("llmt_file_filter",f)}catch{}
  document.querySelectorAll("#drawerFilters button").forEach(b=>b.classList.toggle("active",b.textContent.toLowerCase().startsWith(f==="all"?"all":f)));
  renderDrawer();
}

function highlightText(text, query){
  if(!query) return esc(text);
  const escaped=esc(text);
  const re=new RegExp("("+query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+")","gi");
  return escaped.replace(re,"<mark>$1</mark>");
}

function matchesSearch(p, q){
  if(!q) return true;
  const low=q.toLowerCase();
  const fields=[p.title,p.content?.body_text,p.content?.subject,p.content?.from,
    Array.isArray(p.content?.to)?p.content.to.join(" "):p.content?.to,p.type].filter(Boolean);
  return fields.some(f=>f.toLowerCase().includes(low));
}

function timeAgo(ts){
  if(!ts) return "";
  const ms=Date.now()-new Date(ts).getTime();
  if(ms<60000) return "now";
  if(ms<3600000) return Math.floor(ms/60000)+"m";
  if(ms<86400000) return Math.floor(ms/3600000)+"h";
  return Math.floor(ms/86400000)+"d";
}
function formatSize(b){if(b<1024)return b+"B";if(b<1048576)return(b/1024).toFixed(1)+"KB";return(b/1048576).toFixed(1)+"MB"}
function renderAttachmentsHtml(previewId,attachments){
  let h='';
  attachments.forEach(a=>{
    const aUrl="/api/previews/"+previewId+"/attachments/"+encodeURIComponent(a.filename);
    const isAudio=/\.(mp3|wav|m4a|ogg|webm)$/i.test(a.filename);
    if(isAudio){
      h+='<div style="margin:6px 0"><div style="font-size:11px;color:var(--dim);margin-bottom:4px">🔊 '+esc(a.filename)+(a.size?" ("+formatSize(a.size)+")":"")+'</div><audio controls preload="metadata" style="width:100%;height:36px" src="'+aUrl+'"></audio></div>';
    } else {
      h+='<a class="fp-att" href="'+aUrl+'" target="_blank">📎 '+esc(a.filename)+(a.size?" ("+formatSize(a.size)+")":"")+'</a>';
    }
  });
  return h;
}



// ── File preview modal ──
function openFileModal(title, filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const url = apiUrl('/api/file?path=' + encodeURIComponent(filePath));
  const icon = ext === 'pdf' ? '📕' : ['png','jpg','jpeg','gif','svg'].includes(ext) ? '🖼' : '📄';
  document.getElementById('fm-icon').textContent = icon;
  document.getElementById('fm-title').textContent = title;
  const link = document.getElementById('fm-open-tab');
  link.href = url;
  const body = document.getElementById('fm-body');
  // Remove old content (keep overlay)
  [...body.children].forEach(c => { if (!c.classList.contains('fm-overlay')) c.remove(); });
  let el;
  if (ext === 'pdf') {
    el = document.createElement('iframe');
    el.src = url;
    el.title = title;
  } else if (['png','jpg','jpeg','gif','svg'].includes(ext)) {
    el = document.createElement('img');
    el.src = url;
    el.alt = title;
  } else {
    el = document.createElement('pre');
    fetch(url).then(r=>r.text()).then(t=>{ el.textContent = t; }).catch(()=>{ el.textContent = 'Could not load file.'; });
  }
  body.appendChild(el);
  const modal = document.getElementById('file-modal');
  modal.classList.add('open');
  document.addEventListener('keydown', _fmKeyHandler);
  document.body.style.overflow = 'hidden';
}
function closeFileModal() {
  const modal = document.getElementById('file-modal');
  modal.classList.remove('open');
  document.removeEventListener('keydown', _fmKeyHandler);
  document.body.style.overflow = '';
  const body = document.getElementById('fm-body');
  [...body.children].forEach(c => { if (!c.classList.contains('fm-overlay')) c.remove(); });
}
function _fmKeyHandler(e) { if (e.key === 'Escape') closeFileModal(); }

function fileBodyHtml(bodyText, title, query) {
  if (!bodyText) return '';
  if (bodyText.startsWith('FILE_PATH:')) {
    var fp = bodyText.slice('FILE_PATH:'.length);
    var ext = fp.split('.').pop().toLowerCase();
    var url = apiUrl('/api/file?path=' + encodeURIComponent(fp));
    const openModal = "openFileModal('" + esc(fp.split('/').pop()).replace(/'/g,"\\'") + "','" + fp.replace(/'/g,"\\'") + "')";
    if (ext === 'pdf') {
      return '<div class="fp-pdf-wrap">'
           + '<div style="display:flex;gap:8px;margin-bottom:6px">'
           + '<button class="fm-btn" onclick="' + openModal + '" style="font-size:12px">&#x26F6; Full screen</button>'
           + '<a class="fm-btn" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" style="font-size:12px;text-decoration:none">&#8599; New tab</a>'
           + '</div>'
           + '<iframe src="' + esc(url) + '" class="fp-pdf"></iframe></div>';
    }
    if (['png','jpg','jpeg','gif','svg'].includes(ext)) {
      return '<div>'
           + '<button class="fm-btn" onclick="' + openModal + '" style="font-size:12px;margin-bottom:6px">&#x26F6; Full screen</button>'
           + '<img src="' + esc(url) + '" style="max-width:100%;border-radius:6px;display:block" loading="lazy"></div>';
    }
    return '<a class="fp-att" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">&#8599; ' + esc(fp.split('/').pop()) + '</a>';
  }
  return '<div class="fp-body">' + (query ? highlightText(bodyText, query) : esc(bodyText)) + '</div>';
}

function fileSnippet(bodyText) {
  if (!bodyText) return '';
  if (bodyText.startsWith('FILE_PATH:')) return '📄 ' + bodyText.split('/').pop();
  return bodyText.slice(0, 80).replace(/\n/g, ' ');
}

function renderDrawer(){
  const list=document.getElementById("drawerList");
  const countEl=document.getElementById("drawerCount");
  const query=(document.getElementById("drawerSearch")?.value||"").trim();
  let filtered=sessionPreviews;
  if(fileFilter!=="all") filtered=filtered.filter(p=>p.type===fileFilter);
  if(query) filtered=filtered.filter(p=>matchesSearch(p,query));
  countEl.textContent=filtered.length+"/"+sessionPreviews.length+" files (filter="+(fileFilter||"all")+")";
  if(!filtered.length){list.innerHTML='<div class="drawer-empty">'+(query?"No matches":"No files in this session")+'</div>';return;}
  list.innerHTML="";
  // Sort newest first
  filtered=filtered.slice().sort((a,b)=>(b.created_at||"").localeCompare(a.created_at||""));
  // Group by time bucket
  const now=Date.now();
  const groups={};const order=["Last hour","Today","Yesterday","This week","Older"];
  order.forEach(o=>groups[o]=[]);
  filtered.forEach(p=>{
    const t=p.created_at?new Date(p.created_at).getTime():0;
    const age=now-t;
    let bucket="Older";
    if(age<3600000)bucket="Last hour";
    else if(age<86400000)bucket="Today";
    else if(age<172800000)bucket="Yesterday";
    else if(age<604800000)bucket="This week";
    groups[bucket].push(p);
  });
  order.forEach(bucket=>{
    if(!groups[bucket].length)return;
    const grp=mk("div","drawer-group");
    const h=mk("div","drawer-group-h");h.textContent=bucket+" ("+groups[bucket].length+")";
    grp.appendChild(h);
    groups[bucket].forEach(p=>{
    const card=mk("div","fp-card"+(expandedPreviewId===p.id?" active":""));
    const icon=p.type==="email"?"✉️":p.type==="document"?"📄":"📎";
    const snippet=fileSnippet(p.content?.body_text||'');
    const ago=timeAgo(p.created_at);
    let html='<div class="fp-head"><span class="fp-icon">'+icon+'</span><span class="fp-title">'+highlightText(p.title||"Untitled",query)+'</span><span class="fp-time">'+ago+'</span><span class="fp-type">'+esc(p.type||"file")+'</span></div>';
    if(expandedPreviewId!==p.id&&snippet) html+='<div class="fp-snippet">'+highlightText(snippet,query)+'</div>';
    if(expandedPreviewId===p.id){
      html+='<div class="fp-detail">';
      if(p.content){
        const c=p.content;
        if(c.from||c.to||c.subject){
          html+='<div class="fp-meta">';
          if(c.from) html+='<div>From: <span>'+highlightText(c.from,query)+'</span></div>';
          if(c.to) html+='<div>To: <span>'+highlightText(Array.isArray(c.to)?c.to.join(", "):c.to||"",query)+'</span></div>';
          if(c.subject) html+='<div>Subject: <span>'+highlightText(c.subject,query)+'</span></div>';
          html+='</div>';
        }
        if(c.body_text) html+=fileBodyHtml(c.body_text,p.title,query);
      }
      if(p.attachments&&p.attachments.length){
        html+='<div class="fp-attachments">'+renderAttachmentsHtml(p.id,p.attachments)+'</div>';
      }
      html+='</div>';
      html+='<div class="fp-actions"><button onclick="copyPreviewText(\''+p.id+'\')">Copy</button><button onclick="reviewPreview(\''+p.id+'\',\'revise\')">Revise</button><button class="danger" onclick="deletePreview(\''+p.id+'\')">Delete</button></div>';
    }
    card.innerHTML=html;
    card.querySelector(".fp-head").onclick=()=>{expandedPreviewId=expandedPreviewId===p.id?null:p.id;renderDrawer()};
    if(card.querySelector(".fp-snippet")) card.querySelector(".fp-snippet").onclick=card.querySelector(".fp-head").onclick;
    grp.appendChild(card);
    });
    list.appendChild(grp);
  });
}

function copyPreviewText(id){
  const p=sessionPreviews.find(x=>x.id===id);if(!p)return;
  navigator.clipboard.writeText(p.content?.body_text||p.title||"").catch(()=>{});
}
async function deletePreview(id){
  try{await fetch("/api/previews/"+id,{method:"DELETE"});await refreshPreviews(false)}catch{}
}

function toggleDrawer(){
  const dw=document.getElementById("drawer");
  dw.classList.toggle("hidden");
  try{localStorage.setItem("llmt_drawer_open",String(!dw.classList.contains("hidden")))}catch{}
  // If opening the drawer, refresh previews so user sees latest files
  if(!dw.classList.contains("hidden")){
    try{refreshPreviews(false);}catch{}
  }
}

// ── Decisions drawer (timeline / tree of agent decisions) ──
let _decisions = [];
let _decisionsView  = (function(){try{return localStorage.getItem("llmt_decisions_view")||"timeline"}catch{return "timeline"}})();
let _decisionsScope = (function(){try{return localStorage.getItem("llmt_decisions_scope")||"session"}catch{return "session"}})();
const _decisionsExpanded = new Set();

function _bumpDecisionsViewCount(view){
  try {
    const k = "llmt_decisions_view_count_" + view;
    const n = (parseInt(localStorage.getItem(k) || "0", 10) || 0) + 1;
    localStorage.setItem(k, String(n));
  } catch {}
}

function toggleDecisionsDrawer(){
  const dw = document.getElementById("decisionsDrawer");
  if (!dw) return;
  dw.classList.toggle("hidden");
  const open = !dw.classList.contains("hidden");
  try{ localStorage.setItem("llmt_decisions_open", String(open)) }catch{}
  if (open) {
    _syncDecisionsFilterButtons();
    _bumpDecisionsViewCount(_decisionsView);
    loadDecisions();
  }
}

function setDecisionsView(view){
  if (view !== "timeline" && view !== "tree") return;
  _decisionsView = view;
  try{ localStorage.setItem("llmt_decisions_view", view) }catch{}
  _bumpDecisionsViewCount(view);
  _syncDecisionsFilterButtons();
  renderDecisions();
}

function setDecisionsScope(scope){
  if (scope !== "session" && scope !== "project") return;
  _decisionsScope = scope;
  try{ localStorage.setItem("llmt_decisions_scope", scope) }catch{}
  _syncDecisionsFilterButtons();
  loadDecisions();
}

function _syncDecisionsFilterButtons(){
  document.querySelectorAll("#decisionsFilters [data-dv]").forEach(b => b.classList.toggle("active", b.dataset.dv === _decisionsView));
  document.querySelectorAll("#decisionsFilters [data-dv-scope]").forEach(b => b.classList.toggle("active", b.dataset.dvScope === _decisionsScope));
}

async function loadDecisions(){
  const list = document.getElementById("decisionsList");
  if (!list) return;
  let url;
  if (_decisionsScope === "project") {
    if (!session || !session.project) {
      list.innerHTML = '<div class="drawer-empty">No project selected</div>';
      return;
    }
    url = apiUrl("/api/projects/" + encodeURIComponent(session.project) + "/decisions");
  } else {
    if (!session || !session.id) {
      list.innerHTML = '<div class="drawer-empty">Open a chat first</div>';
      return;
    }
    url = apiUrl("/api/sessions/" + session.id + "/decisions");
  }
  try {
    const r = await fetch(url);
    const data = await r.json();
    _decisions = Array.isArray(data.decisions) ? data.decisions : [];
  } catch (e) {
    _decisions = [];
    list.innerHTML = '<div class="drawer-empty">Failed to load decisions</div>';
    return;
  }
  renderDecisions();
}

function renderDecisions(){
  const list = document.getElementById("decisionsList");
  const cnt  = document.getElementById("decisionsCount");
  if (!list) return;
  if (cnt) cnt.textContent = _decisions.length ? String(_decisions.length) : "";
  if (!_decisions.length) {
    list.innerHTML = '<div class="drawer-empty">No decisions recorded yet. Agents call <code>llmt_decide</code> to add them.</div>';
    return;
  }
  if (_decisionsView === "tree") {
    list.innerHTML = _renderTreeHtml(_decisions);
  } else {
    list.innerHTML = _renderTimelineHtml(_decisions);
  }
  // Wire expand toggles
  list.querySelectorAll(".dec-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("a") || e.target.closest("button")) return;
      const id = row.dataset.did;
      if (_decisionsExpanded.has(id)) _decisionsExpanded.delete(id);
      else _decisionsExpanded.add(id);
      renderDecisions();
    });
  });
}

function _decStatusClass(s){ return "dec-status-" + (s || "pending"); }
function _decStatusIcon(s){
  return s === "verified" ? "✓"
       : s === "reversed" ? "↺"
       : s === "mined"    ? "~"
       : "•";
}

function _renderDecisionRow(d, depth){
  const id = String(d.id);
  const expanded = _decisionsExpanded.has(id);
  const indent = depth ? `style="margin-left:${depth * 18}px"` : "";
  const stClass = _decStatusClass(d.status);
  const ic = _decStatusIcon(d.status);
  let body = "";
  if (expanded) {
    const alts = Array.isArray(d.alternatives) && d.alternatives.length
      ? d.alternatives.map(a => `<li>${esc(a)}</li>`).join("")
      : "<li class=\"dec-empty\">(none recorded)</li>";
    const cons = Array.isArray(d.constraints) && d.constraints.length
      ? `<div class="dec-section"><div class="dec-label">Constraints</div><ul>${d.constraints.map(c => `<li>${esc(c)}</li>`).join("")}</ul></div>`
      : "";
    const cost = d.cost ? `<div class="dec-section"><div class="dec-label">Cost</div><div>${esc(d.cost)}</div></div>` : "";
    let arts = "";
    if (d.artifacts) {
      try {
        const parts = [];
        for (const [k, v] of Object.entries(d.artifacts)) {
          if (Array.isArray(v)) parts.push(`<li><b>${esc(k)}:</b><ul>${v.map(x => `<li>${esc(x)}</li>`).join("")}</ul></li>`);
          else parts.push(`<li><b>${esc(k)}:</b> ${esc(typeof v === "string" ? v : JSON.stringify(v))}</li>`);
        }
        if (parts.length) arts = `<div class="dec-section"><div class="dec-label">Artifacts</div><ul>${parts.join("")}</ul></div>`;
      } catch {}
    }
    const mined = d.mined ? ` <span class="dec-mined" title="Auto-extracted, lower confidence">mined</span>` : "";
    body = `
      <div class="dec-detail">
        <div class="dec-section"><div class="dec-label">Chose</div><div>${esc(d.chose)}</div></div>
        <div class="dec-section"><div class="dec-label">Alternatives</div><ul>${alts}</ul></div>
        <div class="dec-section"><div class="dec-label">Why</div><div>${esc(d.why || "")}</div></div>
        ${cons}${cost}${arts}
        <div class="dec-meta">#${id} · ${esc(d.status)}${mined}</div>
      </div>`;
  }
  return `<div class="dec-row" data-did="${id}" ${indent}>
    <div class="dec-headline">
      <span class="dec-dot ${stClass}" title="${esc(d.status)}">${ic}</span>
      <div class="dec-title">${esc(d.summary)}</div>
      <div class="dec-when">${relativeTime(d.ts)}</div>
    </div>
    ${body}
  </div>`;
}

function _renderTimelineHtml(decisions){
  // Newest first feels more useful — recent forks are what you usually want to find.
  const sorted = [...decisions].sort((a,b) => (b.ts||0) - (a.ts||0));
  return sorted.map(d => _renderDecisionRow(d, 0)).join("");
}

function _renderTreeHtml(decisions){
  const byParent = new Map();
  for (const d of decisions) {
    const p = d.parent_id == null ? "ROOT" : String(d.parent_id);
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(d);
  }
  for (const arr of byParent.values()) arr.sort((a,b) => (a.ts||0) - (b.ts||0));
  const out = [];
  function walk(parentKey, depth) {
    const kids = byParent.get(parentKey) || [];
    for (const d of kids) {
      out.push(_renderDecisionRow(d, depth));
      walk(String(d.id), depth + 1);
    }
  }
  walk("ROOT", 0);
  // Orphans (parent_id points at a decision not in this list — e.g. project view with truncation)
  const known = new Set(decisions.map(d => String(d.id)));
  for (const d of decisions) {
    if (d.parent_id != null && !known.has(String(d.parent_id))) {
      // already handled above only if parent is missing AND we haven't rendered yet
    }
  }
  return out.join("") || '<div class="drawer-empty">No decisions to render</div>';
}

// ── Audio Review Tool ──
let audioReviewState={}; // {rowId_lang: {flagged: Set<index>}}

async function loadAudioReview(rowId, lang){
  try{
    const res=await fetch("/api/content-planner/row/"+rowId+"/voiceover/segments",{headers:{"Origin":"http://localhost"}}).then(r=>r.json());
    const langData=res.languages?.[lang];
    if(!langData||!langData.segments?.length) return null;
    return {rowId,lang,objective:res.objective||"",tabTitle:res.tab_title||"",segments:langData.segments,voiceId:langData.voice_id};
  }catch(e){console.error(e);return null}
}

function renderAudioReview(data){
  const stateKey=data.rowId+"_"+data.lang;
  if(!audioReviewState[stateKey]) audioReviewState[stateKey]={flagged:new Set()};
  const state=audioReviewState[stateKey];

  const d=mk("div","audio-review");
  d.id="ar-"+stateKey;
  let html='<div class="ar-header"><span class="fp-icon">🎙️</span><span class="ar-title">'+esc(data.objective)+'</span><span class="ar-lang">'+esc(data.lang)+'</span></div>';
  html+='<div class="ar-segments">';
  data.segments.forEach((seg,i)=>{
    const isFlagged=state.flagged.has(seg.index);
    html+='<div class="ar-seg'+(isFlagged?" flagged":"")+'" data-idx="'+seg.index+'">';
    html+='<div class="ar-idx">#'+seg.index+'</div>';
    html+='<div class="ar-body">';
    if(seg.key) html+='<div class="ar-key">'+esc(seg.key)+'</div>';
    html+='<div class="ar-text">'+esc((seg.text||"").slice(0,200))+'</div>';
    if(seg.audio_url) html+='<audio controls preload="none" src="'+seg.audio_url+'"></audio>';
    else html+='<div style="font-size:10px;color:var(--dim);font-style:italic">No audio cached</div>';
    html+='<div class="ar-actions">';
    html+='<button class="'+(isFlagged?"flagged":"")+'" onclick="toggleSegmentFlag(\''+stateKey+'\','+seg.index+',\''+data.rowId+'\',\''+data.lang+'\')">🚩 '+(isFlagged?"Flagged":"Flag")+'</button>';
    html+='</div>';
    html+='</div></div>';
  });
  html+='</div>';
  // Regen bar
  const flagCount=state.flagged.size;
  html+='<div class="ar-regen"><span>'+(flagCount?flagCount+' flagged':'No segments flagged')+'</span>';
  if(flagCount) html+='<button onclick="regenFlagged(\''+stateKey+'\',\''+data.rowId+'\',\''+data.lang+'\')">Regenerate flagged</button>';
  html+='</div>';
  d.innerHTML=html;
  return d;
}

function toggleSegmentFlag(stateKey,index,rowId,lang){
  const state=audioReviewState[stateKey];
  if(!state) return;
  if(state.flagged.has(index)) state.flagged.delete(index);
  else state.flagged.add(index);
  // Re-render in place
  const el=document.getElementById("ar-"+stateKey);
  if(el){
    loadAudioReview(rowId,lang).then(data=>{
      if(data){
        const newEl=renderAudioReview(data);
        el.replaceWith(newEl);
      }
    });
  }
}

function regenFlagged(stateKey,rowId,lang){
  const state=audioReviewState[stateKey];
  if(!state||!state.flagged.size) return;
  const indices=[...state.flagged].sort((a,b)=>a-b);
  const msg="Regenerate voiceover segments "+indices.map(i=>"#"+i).join(", ")+" for row "+rowId+" ("+lang+"). Only these segments — do NOT regenerate any others.";
  inp.value=msg;
  localStorage.setItem("llmt_draft",inp.value);
  inp.focus();
}

// Hook: detect when Claude mentions voiceover segments in response and auto-load review
async function checkForAudioReview(text){
  if(!text) return;
  // Look for patterns like "row 2" or "row_id: 2" or "/voiceover/segments"
  const rowMatch=text.match(/row[\s_]?(?:id)?[\s:]*(\d+)/i);
  if(!rowMatch) return;
  const rowId=rowMatch[1];
  for(const lang of ["en","es"]){
    const data=await loadAudioReview(rowId,lang);
    if(data&&data.segments.length>0){
      const el=renderAudioReview(data);
      chat.appendChild(el);
      scrollToBottomIfSticky();
    }
  }
}


function addTool(name,body){
  const d=mk("div","msg tool");
  const n=mk("div","tool-name"); n.textContent=name;
  const b=mk("div","tool-body"); b.textContent=body;
  d.appendChild(n); d.appendChild(b);
  chat.appendChild(d);
  scrollToBottomIfSticky();
}
function addSystem(text){const d=mk("div","msg system");d.textContent=text;chat.appendChild(d)}
function addQueued(text){const d=mk("div","msg system");d.textContent="Queued: "+text.slice(0,60)+(text.length>60?"...":"");chat.appendChild(d);scrollToBottomIfSticky()}
function renderQueueCount(){
  const _totalQueue = (messageQueue ? _totalQueue : 0) + (_serverQueueDepth || 0);
  let el=document.getElementById("queueCount");
  if(!el){el=mk("span","queue-count");el.id="queueCount";document.querySelector(".topbar").appendChild(el)}
  el.textContent=messageQueue.length?messageQueue.length+" queued":"";
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
      // Remove the "Queued:" system message
      const sysMsgs=chat.querySelectorAll(".msg.system");
      for(const s of sysMsgs){if(s.textContent.startsWith("Queued:"))s.remove()}
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
  const label=mk("div","api-err-label");
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
  html+='<div class="summary-section"><h3>Activity</h3>';
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
    html+='<div class="summary-section"><h3>'+label+' ('+items.length+')</h3><ul class="summary-list">';
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
function toggleVoiceInput(){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    alert("Voice recording not supported in this browser.");return;
  }
  if(voiceActive){ stopVoiceRecording(); return; }
  navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    // Don't specify mimeType — let the browser pick (Safari/iOS breaks with explicit codecs)
    voiceRec=new MediaRecorder(stream);
    voiceChunks=[];
    voiceRec.ondataavailable=(e)=>{ if(e.data) voiceChunks.push(e.data); };
    voiceRec.onstop=()=>{
      stream.getTracks().forEach(t=>t.stop());
      const blob=new Blob(voiceChunks,{type:voiceRec.mimeType||"audio/mp4"});
      voiceChunks=[];
      if(blob.size<1000){ console.log("voice note too short, discarding"); return; }
      sendVoiceNote(blob);
    };
    voiceRec.onerror=(e)=>{
      console.error("MediaRecorder error:",e);
      stream.getTracks().forEach(t=>t.stop());
      endVoiceUI();
    };
    voiceRec.start(); // no timeslice — Safari/iOS breaks with it
    voiceActive=true;
    voiceStartTime=Date.now();
    startVoiceUI();
  }).catch(err=>{
    console.error("mic access denied:",err);
    if(err.name==="NotAllowedError") alert("Microphone access denied. Allow it in your browser settings.");
  });
}
function stopVoiceRecording(){
  if(voiceRec&&voiceRec.state==="recording"){
    try{voiceRec.stop()}catch{}
  }
  endVoiceUI();
}
let voiceMeterCtx=null, voiceMeterAnalyser=null, voiceMeterRAF=null;
function startVoiceUI(){
  const isMobile=window.innerWidth<=768;
  const btn=document.getElementById("micBtn");
  const attachBtn=document.getElementById("attachBtn");
  // Mic button becomes send (↑), Send button becomes cancel (✕), attach hides
  if(btn){btn.classList.add("recording");btn.textContent="↑";}
  if(sendBtn){sendBtn._oldText=sendBtn.textContent;sendBtn.textContent="✕";sendBtn.classList.add("voice-cancel-mode");sendBtn.onclick=cancelVoiceRecording;}
  if(attachBtn){attachBtn.style.visibility="hidden";attachBtn.style.pointerEvents="none";}
  // Desktop: replace textarea with inline recording strip + cancel
  if(inp)inp.dataset.prevValue=inp.value;
  if(!isMobile){
    if(inp)inp.style.display="none";
    let ri=document.getElementById("voiceInline");
    if(!ri){
      ri=mk("div","voice-inline");ri.id="voiceInline";
      const dot=mk("span","voice-dot");
      const time=mk("span","voice-time");time.id="voiceTime";time.textContent="0:00";
      const wave=mk("div","voice-wave voice-wave-sm");wave.id="voiceWave";
      for(let i=0;i<16;i++){const b=mk("div","voice-wave-bar");b.style.setProperty("--i",i);wave.appendChild(b);}
      ri.appendChild(dot);ri.appendChild(time);ri.appendChild(wave);
      const bar=document.querySelector(".input-bar");
      bar.insertBefore(ri,bar.firstChild);
    }
    ri.style.display="flex";
  } else {
    if(inp){inp.value="";inp.readOnly=true;inp.placeholder="⏺ Recording...";}
  }
  if(isMobile){
    // Mobile: also show full-screen overlay with big buttons
    let timer=document.getElementById("voiceTimer");
    if(!timer){
      timer=mk("div","voice-timer");timer.id="voiceTimer";
      const info=mk("div","voice-info");
      const dot2=mk("span","voice-dot");
      const time2=mk("span","voice-time");time2.id="voiceTimeMobile";time2.textContent="0:00";
      const wave2=mk("div","voice-wave");wave2.id="voiceWaveMobile";
      for(let i=0;i<20;i++){const b=mk("div","voice-wave-bar");b.style.setProperty("--i",i);wave2.appendChild(b);}
      info.appendChild(dot2);info.appendChild(time2);info.appendChild(wave2);
      const actions=mk("div","voice-actions");
      const cancel=mk("button","voice-cancel");cancel.textContent="✕ Cancel";
      cancel.onclick=(e)=>{e.stopPropagation();cancelVoiceRecording();};
      const send=mk("button","voice-send");send.textContent="Send ↑";
      send.onclick=(e)=>{e.stopPropagation();stopVoiceRecording();};
      actions.appendChild(cancel);actions.appendChild(send);
      timer.appendChild(info);timer.appendChild(actions);
      document.body.appendChild(timer);
    }
    timer.style.display="flex";
    try{if(document.documentElement.requestFullscreen)document.documentElement.requestFullscreen().catch(()=>{});}catch{}
  }

  // Start drawing the live waveform from the active audio stream
  try{
    if(voiceRec && voiceRec.stream){
      voiceMeterCtx = new (window.AudioContext||window.webkitAudioContext)();
      const src = voiceMeterCtx.createMediaStreamSource(voiceRec.stream);
      voiceMeterAnalyser = voiceMeterCtx.createAnalyser();
      voiceMeterAnalyser.fftSize = 64;
      src.connect(voiceMeterAnalyser);
      const data = new Uint8Array(voiceMeterAnalyser.frequencyBinCount);
      const bars = document.querySelectorAll("#voiceWave .voice-wave-bar, #voiceWaveMobile .voice-wave-bar");
      bars.forEach(b=>b.classList.add("live"));
      function draw(){
        voiceMeterAnalyser.getByteFrequencyData(data);
        for(let i=0;i<bars.length;i++){
          const v = data[i] || 0;
          const h = Math.max(3, Math.floor((v/255)*22));
          bars[i].style.height = h+"px";
        }
        voiceMeterRAF = requestAnimationFrame(draw);
      }
      draw();
    }
  }catch(e){ console.warn("voice meter init failed:", e.message); }

  voiceTimerInterval=setInterval(()=>{
    const s=Math.floor((Date.now()-voiceStartTime)/1000);
    const txt=Math.floor(s/60)+":"+(s%60<10?"0":"")+(s%60);
    const el=document.getElementById("voiceTime");if(el)el.textContent=txt;
    const el2=document.getElementById("voiceTimeMobile");if(el2)el2.textContent=txt;
  },500);
}
function endVoiceUI(){
  voiceActive=false;
  const btn=document.getElementById("micBtn");
  if(btn){btn.classList.remove("recording");btn.textContent="🎙";}
  if(sendBtn){sendBtn.textContent=sendBtn._oldText||"Send";sendBtn.classList.remove("voice-cancel-mode");sendBtn.onclick=send;}
  const attachBtn=document.getElementById("attachBtn");
  if(attachBtn){attachBtn.style.visibility="";attachBtn.style.pointerEvents="";}
  if(inp){inp.style.display="";inp.readOnly=false;inp.value=inp.dataset.prevValue||"";inp.placeholder="Message Claude...";}
  const ri=document.getElementById("voiceInline");
  if(ri)ri.style.display="none";
  const timer=document.getElementById("voiceTimer");
  if(timer)timer.style.display="none";
  if(voiceTimerInterval){clearInterval(voiceTimerInterval);voiceTimerInterval=null;}
  if(voiceMeterRAF){cancelAnimationFrame(voiceMeterRAF);voiceMeterRAF=null;}
  if(voiceMeterCtx){try{voiceMeterCtx.close();}catch{}; voiceMeterCtx=null; voiceMeterAnalyser=null;}
  try{if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});}catch{}
}
function cancelVoiceRecording(){
  if(voiceRec&&voiceRec.state==="recording"){
    voiceRec.ondataavailable=null; // discard data
    voiceRec.onstop=()=>{
      voiceRec.stream&&voiceRec.stream.getTracks().forEach(t=>t.stop());
    };
    try{voiceRec.stop()}catch{}
  }
  endVoiceUI();
}
async function sendVoiceNote(blob){
  const duration=Math.floor((Date.now()-voiceStartTime)/1000);
  // Capture any pending images to send with this voice note
  const vnImages=pendingImages.map(i=>({data:i.data,mimeType:i.mimeType}));
  const vnPreviews=pendingImages.map(i=>i.preview);
  const msgEl=addVoiceNoteUser(blob,duration,vnPreviews);
  if(vnImages.length) clearImages();
  const statusEl=msgEl.querySelector(".vn-status");
  const setVnStatus=(txt,cls)=>{
    if(statusEl){statusEl.textContent=txt;statusEl.className="vn-status"+(cls?" "+cls:"");}
  };
  try{
    setVnStatus("Uploading…","vn-s-active");
    const sid=(session&&session.id)||"";
    // Track upload progress via XMLHttpRequest for real upload %
    const data=await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open("POST","./voice-note"+(sid?"?session="+encodeURIComponent(sid):""));
      xhr.setRequestHeader("Content-Type",blob.type||"audio/mp4");
      xhr.upload.onprogress=(e)=>{
        if(e.lengthComputable){
          const pct=Math.round(e.loaded/e.total*100);
          setVnStatus("Uploading… "+pct+"%","vn-s-active");
          if(pct>=100) setVnStatus("Transcribing…","vn-s-active");
        }
      };
      xhr.upload.onload=()=>{ setVnStatus("Transcribing…","vn-s-active"); };
      xhr.onload=()=>{
        if(xhr.status>=400) return reject(new Error("upload failed: "+xhr.status));
        try{resolve(JSON.parse(xhr.responseText))}catch(e){reject(e)}
      };
      xhr.onerror=()=>reject(new Error("network error"));
      xhr.send(blob);
    });
    if(data.error) console.error("[voice-note] error:", data.error);
    // Update title
    const titleEl=msgEl.querySelector(".vn-title");
    if(titleEl&&data.title) titleEl.textContent=data.title;
    // Update transcript (hidden until user taps toggle)
    const transcriptEl=msgEl.querySelector(".vn-transcript");
    const toggleEl=msgEl.querySelector(".vn-toggle");
    if(transcriptEl&&data.transcript){
      transcriptEl.textContent=data.transcript;
      if(toggleEl) toggleEl.classList.add("vn-ready");
    } else if(transcriptEl&&data.error){
      transcriptEl.textContent="⚠ "+data.error;
      transcriptEl.classList.add("vn-error");
      if(toggleEl) toggleEl.classList.add("vn-ready");
    }
    // Update audio src to server URL
    const audioEl=msgEl.querySelector("audio");
    if(audioEl&&data.audioUrl) audioEl.src=data.audioUrl;
    // Server already queued the transcript — only send from client if images attached
    if(data.transcript&&vnImages.length){
      const clientId=genMsgId();
      outbox.push({id:clientId,text:data.transcript,images:vnImages,ts:Date.now()});saveOutbox();
      if(ws&&ws.readyState===1){
        ws.send(JSON.stringify({type:"prompt",client_id:clientId,text:data.transcript,images:vnImages}));
        setBusy(true);
      }
    }
    // Status — upload succeeded, server handles the rest
    if(data.transcript){
      setVnStatus("Queued","vn-s-done");
      setTimeout(()=>{if(statusEl)statusEl.style.display="none";},2000);
    } else if(data.error){
      setVnStatus("⚠ "+data.error,"vn-s-error");
    } else {
      setVnStatus("Sent","vn-s-done");
      setTimeout(()=>{if(statusEl)statusEl.style.display="none";},2000);
    }
  }catch(err){
    console.error("[voice-note] upload failed:",err);
    setVnStatus("⚠ Upload failed — tap to retry","vn-s-error");
    // Tap to retry
    msgEl.onclick=()=>{msgEl.onclick=null;sendVoiceNote(blob);};
  }
}

// Visual viewport: keep chat scrolled to bottom when keyboard opens
if(window.visualViewport){
  window.visualViewport.addEventListener("resize",()=>{
    // If viewport shrank (keyboard opened), scroll chat to bottom to keep context visible
    if(document.activeElement===inp){
      setTimeout(()=>{chat.scrollTop=chat.scrollHeight},100);
    }
  });
}

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
  if(localStorage.getItem("llmt_drawer_open")==="true"){
    document.getElementById("drawer").classList.remove("hidden");
  }
  if(localStorage.getItem("llmt_sidebar_open")==="true"){
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
  // Voice note keyboard: Space to record/send, Escape to cancel
  if(e.key===" "&&!voiceActive&&document.activeElement!==inp&&!e.metaKey&&!e.ctrlKey){
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
function toggleTaskBoard(){
  const tb=document.getElementById("taskBoard");
  tb.classList.toggle("hidden");
  if(!tb.classList.contains("hidden")) loadTasks();
}
function setTaskFilter(f){
  taskFilter=f;
  document.querySelectorAll("#taskFilters button").forEach(b=>b.classList.toggle("active",b.dataset.tf===f));
  renderTasks();
}
async function loadTasks(){
  try{
    const r=await fetch("./api/tasks?limit=100");
    if(!r.ok) throw new Error(""+r.status);
    const data=await r.json();
    taskCache=data.items||[];
    renderTasks();
    updateTaskBadge();
  }catch(err){
    document.getElementById("taskList").innerHTML='<div class="drawer-empty">Failed to load tasks</div>';
    console.error("[tasks]",err);
  }
}
function renderTasks(){
  const list=document.getElementById("taskList");
  const actionable=["blocked","review","new"];
  const active=["in_progress","queued","triaged"];
  let items=taskCache;
  if(taskFilter==="actionable") items=items.filter(t=>actionable.includes(t.status));
  else if(taskFilter==="active") items=items.filter(t=>active.includes(t.status)||actionable.includes(t.status));
  // Group by project
  const groups={};
  items.forEach(t=>{
    const p=t.target_project||t.project_id||"other";
    if(!groups[p])groups[p]=[];
    groups[p].push(t);
  });
  if(!items.length){
    list.innerHTML='<div class="drawer-empty">No tasks match filter</div>';
    document.getElementById("taskCount").textContent="";
    return;
  }
  document.getElementById("taskCount").textContent=items.length;
  let html="";
  for(const [proj,tasks] of Object.entries(groups).sort()){
    html+='<div class="tk-group"><div class="tk-proj">'+esc(proj)+'</div>';
    tasks.forEach(t=>{
      const statusCls="tk-s-"+t.status;
      const pri=t.priority==="urgent"?"!!! ":t.priority==="high"?"!! ":"";
      html+='<div class="tk-item '+statusCls+'" data-tid="'+t.task_id+'">';
      html+='<div class="tk-title" onclick="loadTaskIntoChat(this.parentNode)">'+esc(pri+t.title)+'</div>';
      html+='<div class="tk-meta"><span class="tk-status">'+esc(t.status)+'</span>';
      if(t.blocked_reason) html+='<span class="tk-blocked">'+esc(t.blocked_reason.slice(0,40))+'</span>';
      html+='<span class="tk-date">'+new Date(t.created_at).toLocaleDateString()+'</span></div>';
      // Action buttons based on status
      html+='<div class="tk-actions">';
      if(t.status==="blocked") html+='<button class="tk-btn tk-btn-retry" onclick="taskAction(\''+t.task_id+'\',\'retry\')">↻ Retry</button>';
      if(t.status==="blocked") html+='<button class="tk-btn tk-btn-close" onclick="taskAction(\''+t.task_id+'\',\'close\')">✕ Close</button>';
      if(t.status==="review") html+='<button class="tk-btn tk-btn-approve" onclick="taskAction(\''+t.task_id+'\',\'merge\')">✓ Approve</button>';
      if(t.status==="review") html+='<button class="tk-btn tk-btn-close" onclick="taskAction(\''+t.task_id+'\',\'close\')">✕ Close</button>';
      if(t.status==="new") html+='<button class="tk-btn tk-btn-retry" onclick="taskAction(\''+t.task_id+'\',\'queue\')">▶ Queue</button>';
      if(t.status==="new") html+='<button class="tk-btn tk-btn-close" onclick="taskAction(\''+t.task_id+'\',\'close\')">✕ Close</button>';
      if(t.status==="in_progress") html+='<button class="tk-btn" onclick="loadTaskIntoChat(this.closest(\'.tk-item\'))">💬 Open</button>';
      html+='</div>';
      html+='</div>';
    });
    html+='</div>';
  }
  list.innerHTML=html;
}
function updateTaskBadge(){
  const actionable=taskCache.filter(t=>["blocked","review","new"].includes(t.status));
  const n=actionable.length;
  ["tasksBadge","tasksBadgeMobile"].forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.textContent=n;el.style.display=n?"":"none";}
  });
}
function loadTaskIntoChat(el){
  const tid=el.dataset.tid;
  const t=taskCache.find(t=>t.task_id===tid);
  if(!t) return;
  const desc=(t.description||"").slice(0,500);
  const text="[Task: "+t.title+"]\nProject: "+(t.target_project||t.project_id)+"\nStatus: "+t.status
    +(t.blocked_reason?"\nBlocked: "+t.blocked_reason:"")
    +(desc?"\n\n"+desc:"")
    +"\n\nWhat should we do with this?";
  inp.value=text;
  autoResizeInput(inp);
  localStorage.setItem("llmt_draft",inp.value);
  // Link this session to the task
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:"link_task",task_id:tid}));
  toggleTaskBoard();
  if(window.innerWidth>768) inp.focus();
}
// ── Floating Action Button (FAB) — round-robin + quick actions ──
(function(){
  const fab=document.getElementById("fab");
  if(!fab)return;
  const fabCount=document.getElementById("fabCount");
  let isDragging=false, dragStartX=0, dragStartY=0, fabX=0, fabY=0, pressTimer=null;
  // Restore position
  try{const p=JSON.parse(localStorage.getItem("llmt_fab_pos"));if(p){fab.style.right="auto";fab.style.left=p.x+"px";fab.style.top=p.y+"px";fab.style.bottom="auto";}}catch{}

  function updateFabCount(){
    const n=attentionSessionsList().length;
    fabCount.textContent=n;
    fab.classList.toggle("fab-zero",n===0);
  }
  // Expose for polling
  window._updateFabCount=updateFabCount;
  setTimeout(updateFabCount,1500);

  // Tap = next attention session
  fab.addEventListener("click",(e)=>{
    if(isDragging)return;
    nextAttentionSession();
  });

  // Drag support (touch)
  fab.addEventListener("touchstart",(e)=>{
    if(e.touches.length!==1)return;
    const t=e.touches[0];
    dragStartX=t.clientX;dragStartY=t.clientY;
    const r=fab.getBoundingClientRect();
    fabX=r.left;fabY=r.top;
    isDragging=false;
    pressTimer=setTimeout(()=>{showFabMenu();pressTimer=null;},500);
  },{passive:true});
  fab.addEventListener("touchmove",(e)=>{
    if(e.touches.length!==1)return;
    const t=e.touches[0];
    const dx=t.clientX-dragStartX,dy=t.clientY-dragStartY;
    if(Math.abs(dx)>5||Math.abs(dy)>5){
      isDragging=true;
      if(pressTimer){clearTimeout(pressTimer);pressTimer=null;}
      fab.classList.add("fab-dragging");
      fab.style.right="auto";fab.style.bottom="auto";
      fab.style.left=Math.max(0,Math.min(window.innerWidth-60,fabX+dx))+"px";
      fab.style.top=Math.max(0,Math.min(window.innerHeight-60,fabY+dy))+"px";
    }
  },{passive:true});
  fab.addEventListener("touchend",(e)=>{
    if(pressTimer){clearTimeout(pressTimer);pressTimer=null;}
    fab.classList.remove("fab-dragging");
    if(isDragging){
      // Save position
      try{localStorage.setItem("llmt_fab_pos",JSON.stringify({x:parseInt(fab.style.left),y:parseInt(fab.style.top)}));}catch{}
      setTimeout(()=>{isDragging=false;},50);
    }
  },{passive:true});

  // Long-press (mouse)
  fab.addEventListener("mousedown",(e)=>{
    pressTimer=setTimeout(()=>{
      const r=fab.getBoundingClientRect();
      showFabMenu();
      pressTimer=null;
    },500);
  });
  fab.addEventListener("mouseup",()=>{if(pressTimer){clearTimeout(pressTimer);pressTimer=null;}});

  // FAB context menu
  function showFabMenu(){
    const fabRect=fab.getBoundingClientRect();
    // "First gear" — Mark done — sits just BELOW the FAB
    let downMenu=document.getElementById("fabMenuDown");
    if(!downMenu){downMenu=mk("div","fab-menu fab-menu-down");downMenu.id="fabMenuDown";document.body.appendChild(downMenu);}
    downMenu.innerHTML='<button class="fab-menu-item" data-act="mark-done">✅ Done</button>';
    downMenu.style.right=(window.innerWidth-fabRect.right)+"px";
    downMenu.style.top=(fabRect.bottom+6)+"px";
    downMenu.style.display="block";
    // "Upper gears" — sessions needing input — stack ABOVE the FAB
    let upMenu=document.getElementById("fabMenuUp");
    if(!upMenu){upMenu=mk("div","fab-menu fab-menu-up");upMenu.id="fabMenuUp";document.body.appendChild(upMenu);}
    const list=attentionSessionsList();
    let html="";
    if(list.length===0) html='<div class="fab-menu-item" style="color:var(--dim)">All clear</div>';
    list.slice(0,8).forEach(s=>{
      const st=computeSessionState(s);
      const icon=STATE_ICONS[st]||"";
      html+='<button class="fab-menu-item" data-sid="'+s.id+'">'+icon+' '+esc((s.title||"Untitled").slice(0,30))+'</button>';
    });
    upMenu.innerHTML=html;
    upMenu.style.right=(window.innerWidth-fabRect.right)+"px";
    upMenu.style.bottom=(window.innerHeight-fabRect.top+6)+"px";
    upMenu.style.display="block";
    // Shared click handler
    const handler=(e)=>{
      const btn=e.target.closest("[data-sid],[data-act]");
      if(btn&&btn.dataset.sid){
        const s=_allSessions.find(s=>s.id===btn.dataset.sid);
        if(s){resumeSession(s);showAttentionBanner(s);}
      }
      if(btn&&btn.dataset.act==="mark-done"&&session){
        fetch(apiUrl("/api/sessions/"+session.id+"/state"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({manualDone:true})}).then(()=>{
          loadSessions().then(()=>{
            if(window._updateFabCount)window._updateFabCount();
            nextAttentionSession();
          });
        });
      }
      closeFabMenus();
    };
    upMenu.onclick=handler;
    downMenu.onclick=handler;
    setTimeout(()=>{
      const closer=(e)=>{if(!e.target.closest(".fab-menu")&&!e.target.closest(".fab"))closeFabMenus();};
      document.addEventListener("click",closer,{once:true});
      document.addEventListener("touchstart",closer,{once:true,passive:true});
    },50);
  }
  function closeFabMenus(){
    const up=document.getElementById("fabMenuUp"),down=document.getElementById("fabMenuDown");
    if(up)up.style.display="none";
    if(down)down.style.display="none";
  }
})();

async function retryAllBlocked(){
  const blocked=taskCache.filter(t=>t.status==="blocked");
  if(!blocked.length){alert("No blocked tasks");return;}
  let ok=0;
  for(const t of blocked){
    try{
      const r=await fetch("./api/tasks/"+t.task_id+"/transition",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"queued",detail:"Bulk retry from task board"})});
      if(r.ok) ok++;
    }catch{}
  }
  console.log("[tasks] retried "+ok+"/"+blocked.length+" blocked tasks");
  loadTasks();
}
async function taskAction(taskId,action){
  try{
    if(action==="retry"){
      await fetch("./api/tasks/"+taskId+"/transition",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"queued",detail:"Retried from task board"})});
    } else if(action==="close"){
      await fetch("./api/tasks/"+taskId+"/transition",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"closed",detail:"Closed from task board"})});
    } else if(action==="merge"){
      await fetch("./api/tasks/"+taskId+"/transition",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"merged",detail:"Approved from task board"})});
    } else if(action==="queue"){
      await fetch("./api/tasks/"+taskId+"/transition",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"queued",detail:"Queued from task board"})});
    }
    loadTasks();
  }catch(err){console.error("[task-action]",err);}
}

// Auto-load task count on page load
setTimeout(()=>{
  fetch("./api/tasks?limit=100").then(r=>r.json()).then(data=>{
    taskCache=data.items||[];
    updateTaskBadge();
  }).catch(()=>{});
},2000);

// Poll sidebar state every 15s — shows real-time status of all chats
setInterval(()=>{
  fetch(apiUrl("/api/sessions?project=ALL")).then(r=>r.json()).then(sessions=>{
    // Only re-render if something changed
    const changed = sessions.some((s,i) => {
      const old = _allSessions[i];
      return !old || old.lastMessageRole !== s.lastMessageRole || old.lastSnippet !== s.lastSnippet || old.lastActive !== s.lastActive;
    }) || sessions.length !== _allSessions.length;
    if (changed) { _allSessions = sessions; _renderSidebar(); refreshAttentionCounter(); if(window._updateFabCount)window._updateFabCount(); }
  }).catch(()=>{});
}, 15000);

// AI TTS via server /tts endpoint (OpenAI tts-1 + disk cache). Chunked playback:
// splits long messages into ~1000-char segments at sentence boundaries, starts
// playing chunk 0 while the rest are fetched. YouTube-style buffer bar shows progress.
const TTS_CHUNK_TARGET = 1000;
const ttsBlobCache = new Map(); // text -> blob URL
const ttsPending = new Map();   // text -> Promise<blob URL>

function ttsTextKey(t){ return t.length + ":" + t.substring(0, 200) + "|" + t.substring(Math.max(0, t.length-100)); }

function splitTtsChunks(text){
  if(!text) return [];
  // Strip code blocks, image markdown, HTML tags, markdown formatting
  let t = text.replace(/```[\s\S]*?```/g, " [code block] ")
              .replace(/`[^`]+`/g, m => m.slice(1,-1))  // inline code: keep text
              .replace(/!\[.*?\]\(.*?\)/g, "")
              .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")   // links: keep text
              .replace(/<[^>]+>/g, " ")
              .replace(/^#{1,6}\s+/gm, "")                // strip heading markers
              .replace(/^\s*[-*+]\s+/gm, ". ")            // bullets → sentence breaks
              .replace(/^\s*\d+\.\s+/gm, ". ")            // numbered lists → sentence breaks
              .replace(/\*\*|__/g, "")                     // bold markers
              .replace(/[*_]/g, "")                        // italic markers
              .replace(/\n{2,}/g, ".\n")                   // paragraph breaks → sentence break
              .replace(/\s+/g, " ").trim();
  if(!t) return [];
  if(t.length <= TTS_CHUNK_TARGET) return [t];
  // Split at sentence boundaries: .!?;: followed by whitespace
  const sentences = [];
  let buf = "";
  for(let i = 0; i < t.length; i++){
    buf += t[i];
    const ch = t[i];
    if(i < t.length - 1 && (ch === '.' || ch === '!' || ch === '?' || ch === ';' || ch === ':')){
      const next = t[i+1];
      if(next === ' ' || next === '\n'){
        sentences.push(buf.trim());
        buf = "";
      }
    }
  }
  if(buf.trim()) sentences.push(buf.trim());
  // Accumulate sentences into chunks near TTS_CHUNK_TARGET
  const chunks = [];
  let cur = "";
  for(const s of sentences){
    if(s.length > TTS_CHUNK_TARGET){
      if(cur) { chunks.push(cur); cur = ""; }
      let rem = s;
      while(rem.length > TTS_CHUNK_TARGET){
        let cut = rem.lastIndexOf(' ', TTS_CHUNK_TARGET);
        if(cut < 200) cut = TTS_CHUNK_TARGET;
        chunks.push(rem.substring(0, cut).trim());
        rem = rem.substring(cut).trim();
      }
      if(rem) cur = rem;
    } else if(cur.length + s.length + 1 > TTS_CHUNK_TARGET){
      chunks.push(cur);
      cur = s;
    } else {
      cur += (cur ? " " : "") + s;
    }
  }
  if(cur) chunks.push(cur);
  return chunks;
}

async function fetchTtsBlob(text){
  if(!text) throw new Error("empty text");
  const key = ttsTextKey(text);
  if(ttsBlobCache.has(key)) return ttsBlobCache.get(key);
  if(ttsPending.has(key))   return ttsPending.get(key);
  const p = (async ()=>{
    const r = await fetch("./tts", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({text})});
    if(!r.ok) throw new Error("tts " + r.status);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    ttsBlobCache.set(key, url);
    return url;
  })();
  ttsPending.set(key, p);
  try { return await p; } finally { ttsPending.delete(key); }
}

function preemptTts(text){
  if(!text || text.length < 20) return;
  const chunks = splitTtsChunks(text);
  // Warm cache for first 2 chunks
  for(let i = 0; i < Math.min(2, chunks.length); i++){
    fetchTtsBlob(chunks[i]).catch(err=>console.warn("[tts preempt]", err.message || err));
  }
}

let ttsSession = null;
let _ttsRaf = null; // requestAnimationFrame handle for progress bar

class TtsSession {
  constructor(text){
    this.chunks = splitTtsChunks(text);
    this.blobUrls = new Array(this.chunks.length).fill(null);
    this.durations = new Array(this.chunks.length).fill(0); // audio duration per chunk (filled after load)
    this.currentChunk = 0;
    this.audio = null;
    this.rate = 1.0;
    this.paused = false;
    this.aborted = false;
  }
  async start(){
    if(!this.chunks.length){ stopTts(); return; }
    // Fetch ALL chunks eagerly so buffer bar fills up
    for(let i = 0; i < this.chunks.length; i++) this._fetchChunk(i);
    try {
      this.blobUrls[0] = await this._fetchChunk(0);
      this._playChunk(0);
    } catch(err){
      console.error("[tts] chunk 0 failed:", err);
      stopTts();
    }
  }
  _fetchChunk(i){
    if(i >= this.chunks.length) return Promise.resolve(null);
    if(this.blobUrls[i]) return Promise.resolve(this.blobUrls[i]);
    return fetchTtsBlob(this.chunks[i]).then(url=>{
      this.blobUrls[i] = url;
      _updateTtsBar(); // update buffer bar when a chunk loads
      return url;
    }).catch(err=>{
      console.warn("[tts] chunk " + i + " fetch failed:", err.message||err);
      this.blobUrls[i] = "ERR";
      return "ERR";
    });
  }
  _playChunk(i){
    if(this.aborted) return;
    while(i < this.chunks.length && this.blobUrls[i] === "ERR") i++;
    if(i >= this.chunks.length){ stopTts(); return; }
    this.currentChunk = i;
    const url = this.blobUrls[i];
    if(!url){
      _updateTtsBar();
      this._fetchChunk(i).then(()=> this._playChunk(i));
      return;
    }
    const audio = new Audio(url);
    audio.playbackRate = this.rate;
    audio.onloadedmetadata = ()=>{ this.durations[i] = audio.duration; _updateTtsBar(); };
    audio.onended = ()=> this._onChunkEnded();
    audio.onerror = ()=>{ console.warn("[tts] audio error chunk " + i); this._onChunkEnded(); };
    this.audio = audio;
    _updateTtsBar();
    if(!this.paused){
      audio.play().catch(err=> console.warn("[tts] play() rejected:", err));
    }
  }
  _onChunkEnded(){
    if(this.aborted) return;
    const next = this.currentChunk + 1;
    if(next >= this.chunks.length){ stopTts(); return; }
    if(this.blobUrls[next] && this.blobUrls[next] !== "ERR"){
      this._playChunk(next);
    } else {
      this.audio = null;
      _updateTtsBar();
      this._fetchChunk(next).then(()=> this._playChunk(next));
    }
  }
  togglePause(){
    if(!this.audio) return;
    if(this.paused){ this.audio.play().catch(()=>{}); this.paused = false; }
    else { this.audio.pause(); this.paused = true; }
    _updateTtsBar();
  }
  setRate(rate){
    this.rate = rate;
    if(this.audio) this.audio.playbackRate = rate;
  }
  stop(){
    this.aborted = true;
    if(this.audio){ try{ this.audio.pause(); this.audio.onended=null; }catch{} }
    this.audio = null;
  }
  // Returns 0..1 for how far through the entire session we are
  getPlaybackFraction(){
    const n = this.chunks.length;
    if(n <= 1 && this.audio && this.audio.duration){
      return this.audio.currentTime / this.audio.duration;
    }
    const chunkFrac = this.audio && this.audio.duration > 0 ? this.audio.currentTime / this.audio.duration : 0;
    return (this.currentChunk + chunkFrac) / n;
  }
  // Returns 0..1 for how much is buffered (fetched)
  getBufferFraction(){
    const loaded = this.blobUrls.filter(u => u && u !== "ERR").length;
    return loaded / this.chunks.length;
  }
}

function playTts(text){
  stopTts();
  const session = new TtsSession(text);
  ttsSession = session;
  _showTtsControls();
  const cached = ttsBlobCache.get(ttsTextKey(session.chunks[0] || ""));
  if(cached) session.blobUrls[0] = cached;
  session.start().catch(err=>{
    console.error("[tts] session failed:", err);
    stopTts();
  });
}

function togglePauseTts(){
  if(ttsSession) ttsSession.togglePause();
}
function cycleTtsSpeed(){
  if(!ttsSession) return;
  const rates = [1.0, 1.25, 1.5, 2.0, 0.85];
  const i = rates.indexOf(ttsSession.rate);
  const newRate = rates[(i+1) % rates.length];
  ttsSession.setRate(newRate);
  _updateTtsBar();
}
function stopTts(){
  if(_ttsRaf){ cancelAnimationFrame(_ttsRaf); _ttsRaf = null; }
  if(ttsSession){ ttsSession.stop(); ttsSession = null; }
  document.querySelectorAll(".tts-controls").forEach(b=>b.remove());
}
function _showTtsControls(){
  document.querySelectorAll(".tts-controls").forEach(b=>b.remove());
  const bar = mk("div","tts-controls");
  const pause = mk("button","tts-btn"); pause.id="ttsPause"; pause.textContent="\u25CB"; pause.onclick=togglePauseTts; pause.title="Pause/Resume";
  // Progress bar container (YouTube-style)
  const progWrap = mk("div","tts-bar-wrap"); progWrap.id="ttsBarWrap";
  const bufBar = mk("div","tts-bar-buf"); bufBar.id="ttsBufBar";
  const playBar = mk("div","tts-bar-play"); playBar.id="ttsPlayBar";
  progWrap.appendChild(bufBar); progWrap.appendChild(playBar);
  const label = mk("span","tts-bar-label"); label.id="ttsBarLabel"; label.textContent="Loading\u2026";
  const speed = mk("button","tts-btn"); speed.id="ttsSpeed"; speed.textContent="1x"; speed.onclick=cycleTtsSpeed; speed.title="Cycle speed";
  const stop  = mk("button","tts-btn tts-stop"); stop.textContent="\u23F9"; stop.onclick=stopTts; stop.title="Stop";
  bar.appendChild(pause); bar.appendChild(progWrap); bar.appendChild(label); bar.appendChild(speed); bar.appendChild(stop);
  document.body.appendChild(bar);
  // Start animation loop for smooth progress bar
  _startTtsRaf();
}
function _startTtsRaf(){
  function tick(){
    if(!ttsSession){ _ttsRaf = null; return; }
    _renderTtsBar();
    _ttsRaf = requestAnimationFrame(tick);
  }
  _ttsRaf = requestAnimationFrame(tick);
}
function _renderTtsBar(){
  if(!ttsSession) return;
  const bufBar = document.getElementById("ttsBufBar");
  const playBar = document.getElementById("ttsPlayBar");
  const label = document.getElementById("ttsBarLabel");
  const pause = document.getElementById("ttsPause");
  const speed = document.getElementById("ttsSpeed");
  if(bufBar) bufBar.style.width = (ttsSession.getBufferFraction() * 100) + "%";
  if(playBar) playBar.style.width = (ttsSession.getPlaybackFraction() * 100) + "%";
  if(label){
    const n = ttsSession.chunks.length;
    const loaded = ttsSession.blobUrls.filter(u => u && u !== "ERR").length;
    if(!ttsSession.audio) label.textContent = "Buffering\u2026 " + loaded + "/" + n;
    else if(n <= 1) label.textContent = "";
    else label.textContent = (ttsSession.currentChunk+1) + " / " + n;
  }
  if(pause) pause.textContent = ttsSession.audio ? (ttsSession.paused ? "\u25B6" : "\u23F8") : "\u25CB";
  if(speed) speed.textContent = ttsSession.rate + "x";
}
function _updateTtsBar(){ _renderTtsBar(); }

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

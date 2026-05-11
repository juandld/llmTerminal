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
let messageQueue=[]; // queued messages to send when Claude is idle

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
      _renderSidebar();
    });
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
function showSessionInfo(x, anchorEl) {
  document.querySelectorAll(".sb-info-popup").forEach(p => p.remove());
  const pop = mk("div", "sb-info-popup");
  const title = mk("div", "pop-title"); title.textContent = x.title || "(no title)";
  pop.appendChild(title);
  const rows = [
    ["Project", x.project || "?"],
    ["Messages", String(x.messageCount || 0)],
    ["Created", x.created ? new Date(x.created).toLocaleString() : "?"],
    ["Last active", x.lastActive ? new Date(x.lastActive).toLocaleString() : "?"],
    ["Status", x.archived ? "Archived (>30d inactive)" : "Active"],
    ["Session ID", (x.id || "").slice(0, 8) + "\u2026"],
  ];
  rows.forEach(([k, v]) => {
    const row = mk("div", "pop-row");
    const ek = mk("span", ""); ek.textContent = k;
    const ev = mk("b", ""); ev.textContent = v;
    row.appendChild(ek); row.appendChild(ev);
    pop.appendChild(row);
  });
  const close = mk("button", "pop-close"); close.textContent = "Close";
  close.onclick = () => pop.remove();
  pop.appendChild(close);
  document.body.appendChild(pop);
  if (anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    let left = r.right + 12;
    let top = r.top;
    if (left + 360 > window.innerWidth) {
      left = Math.max(12, (window.innerWidth - pop.offsetWidth) / 2);
      top = r.bottom + 8;
    }
    if (top + pop.offsetHeight > window.innerHeight) top = Math.max(12, window.innerHeight - pop.offsetHeight - 12);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  } else {
    pop.style.left = "50%"; pop.style.top = "20%";
    pop.style.transform = "translateX(-50%)";
  }
  setTimeout(() => {
    document.addEventListener("click", function close1(e) {
      if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("click", close1); }
    });
  }, 0);
}
function makeSbItem(x, currentProject) {
  const d = document.createElement("div");
  d.className = "sb-item" + (session?.id === x.id ? " active" : "") + (x.archived ? " sb-archived" : "");
  const ti = mk("div", "ti");
  const row1 = mk("div", "row1");
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
  d.appendChild(ti);
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
  _renderSidebar();
}
function _renderSidebar() {
  _updateNewSessionLabel();
  sbList.innerHTML = "";
  const q = (_searchQuery || "").trim().toLowerCase();
  const matches = (x) => !q || (x.title || "").toLowerCase().includes(q) || (x.project || "").toLowerCase().includes(q);
  const filtered = _allSessions.filter(matches);
  const active = filtered.filter(x => !x.archived);
  const archived = filtered.filter(x => x.archived);
  if (!filtered.length && q) {
    const empty = mk("div", "sb-empty");
    empty.textContent = "No sessions match \"" + _searchQuery + "\"";
    sbList.appendChild(empty);
    return;
  }
  const byProj = {};
  active.forEach(x => { (byProj[x.project] = byProj[x.project] || []).push(x); });
  // Include every available project — even ones with zero sessions — so the
  // user can tap a project header to set it as active for "+ New in X".
  // When searching, only show projects that have at least one matching session.
  const seedKeys = q ? Object.keys(byProj) : Array.from(new Set([..._availableProjects, ...Object.keys(byProj)]));
  const projOrder = seedKeys.sort((a, b) => {
    const aMax = Math.max(...((byProj[a] || []).map(x => x.lastActive || 0)), 0);
    const bMax = Math.max(...((byProj[b] || []).map(x => x.lastActive || 0)), 0);
    if (aMax !== bMax) return bMax - aMax;
    return a.localeCompare(b);  // empty groups: alphabetical fallback
  });
  const forceExpand = !!q;
  projOrder.forEach(pname => renderProjectGroup(pname, byProj[pname] || [], sbList, forceExpand));
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
}

function newSession(project){
  // Always show picker if no project given so the user picks explicitly
  // (avoids "session landed in the wrong project" surprises).
  if (!project || project === "ALL") {
    openNewSessionPicker();
    return;
  }
  if(ws) ws.close();
  chat.innerHTML=""; session=null; ws=null; busy=false; removeThinking();
  localStorage.removeItem("llmt_session"); location.hash="";
  try { localStorage.setItem("llmt_project", project); } catch {}
  setBusy(false);
  connect(project, null);
  _updateNewSessionLabel();
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
  if(ws) ws.close();
  chat.innerHTML=""; session=null; ws=null; busy=false; removeThinking();
  try { localStorage.setItem("llmt_project", s.project); } catch {}
  setBusy(false);
  connect(s.project,s.id);
  _updateNewSessionLabel();
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
    setStatus("syncing...","thinking");inp.focus();
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
        loadSessions();
        refreshPreviews(false);
        startBrowserPoll();
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
          if(m.role==="user") addUser(m.text);
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
      case "permission_denied":
        addPermissionCard(msg);
        break;
case "session":
        // Server ships the session object on connect; reflect its current model.
        if (msg.session && modelSel) {
          modelSel.value = msg.session.model || "";
          applyModelDirty();
        }
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
function addAssistant(text, opts){
  const d=mk("div","msg assistant");
  const b=mk("div","bubble");
  b.innerHTML=fmt(text);
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
      inp.style.height="44px";inp.style.height=Math.min(inp.scrollHeight,140)+"px";
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
  inp.focus();
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
    html+='<div class="fp-attachments">';
    p.attachments.forEach(a=>{
      const aUrl="/api/previews/"+p.id+"/attachments/"+encodeURIComponent(a.filename);
      const isAudio=/\.(mp3|wav|m4a|ogg|webm)$/i.test(a.filename);
      if(isAudio){
        html+='<div style="margin:6px 0"><div style="font-size:11px;color:var(--dim);margin-bottom:4px">🔊 '+esc(a.filename)+(a.size?" ("+formatSize(a.size)+")":"")+'</div><audio controls preload="metadata" style="width:100%;height:36px" src="'+aUrl+'"></audio></div>';
      } else {
        html+='<a class="fp-att" href="'+aUrl+'" target="_blank">📎 '+esc(a.filename)+(a.size?" ("+formatSize(a.size)+")":"")+'</a>';
      }
    });
    html+='</div>';
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
  countEl.textContent=filtered.length+" file"+(filtered.length!==1?"s":"");
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
        html+='<div class="fp-attachments">';
        p.attachments.forEach(a=>{
          const aUrl="/api/previews/"+p.id+"/attachments/"+encodeURIComponent(a.filename);
          const isAudio=/\.(mp3|wav|m4a|ogg|webm)$/i.test(a.filename);
          if(isAudio){
            html+='<div style="margin:6px 0"><div style="font-size:11px;color:var(--dim);margin-bottom:4px">🔊 '+esc(a.filename)+(a.size?" ("+formatSize(a.size)+")":"")+'</div><audio controls preload="metadata" style="width:100%;height:36px" src="'+aUrl+'"></audio></div>';
          } else {
            html+='<a class="fp-att" href="'+aUrl+'" target="_blank">📎 '+esc(a.filename)+(a.size?" ("+formatSize(a.size)+")":"")+'</a>';
          }
        });
        html+='</div>';
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
  h=h.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  h=h.replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g,'$1<a href="$2" target="_blank" rel="noopener">$2</a>');
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
    inp.focus();
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

// Voice input via browser SpeechRecognition
let voiceRec=null, voiceActive=false;
function toggleVoiceInput(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){alert("Voice input not supported in this browser. Try Chrome, Edge, or Safari.");return}
  if(voiceActive){
    try{voiceRec&&voiceRec.stop()}catch{}
    return;
  }
  voiceRec=new SR();
  voiceRec.continuous=true;
  voiceRec.interimResults=true;
  voiceRec.lang=navigator.language||"en-US";
  const startValue=inp.value;
  let finalTranscript="";
  voiceRec.onresult=(e)=>{
    let interim="";
    for(let i=e.resultIndex;i<e.results.length;i++){
      const t=e.results[i][0].transcript;
      if(e.results[i].isFinal)finalTranscript+=t;
      else interim+=t;
    }
    inp.value=(startValue?startValue+" ":"")+finalTranscript+interim;
    inp.style.height="44px";inp.style.height=Math.min(inp.scrollHeight,140)+"px";
  };
  voiceRec.onend=()=>{
    voiceActive=false;
    const btn=document.getElementById("micBtn");
    if(btn)btn.classList.remove("recording");
  };
  voiceRec.onerror=(e)=>{
    voiceActive=false;
    const btn=document.getElementById("micBtn");
    if(btn)btn.classList.remove("recording");
    if(e.error==="not-allowed"||e.error==="service-not-allowed"){
      alert("Microphone access denied. Allow it in your browser settings.");
    }
  };
  try{
    voiceRec.start();
    voiceActive=true;
    const btn=document.getElementById("micBtn");
    if(btn)btn.classList.add("recording");
  }catch(e){console.error("voice rec failed:",e)}
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
  inp.style.height="44px";inp.style.height=Math.min(inp.scrollHeight,140)+"px";
  localStorage.setItem("llmt_draft",inp.value);
});
// Restore draft on load
try{const d=localStorage.getItem("llmt_draft");if(d){inp.value=d;inp.style.height="44px";inp.style.height=Math.min(inp.scrollHeight,140)+"px";}}catch{}
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

// AI TTS via server /tts endpoint (OpenAI tts-1 + disk cache). Preemptively warms cache
// when new assistant messages arrive so tapping Read aloud plays instantly.
const TTS_MAX_CHARS = 4000;
const ttsBlobCache = new Map(); // text -> blob URL
const ttsPending = new Map();   // text -> Promise<blob URL>

function ttsTextKey(t){ return t.length + ":" + t.substring(0, 200) + "|" + t.substring(Math.max(0, t.length-100)); }

async function fetchTtsBlob(text){
  if(!text) throw new Error("empty text");
  if(text.length > TTS_MAX_CHARS) text = text.substring(0, TTS_MAX_CHARS);
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
  if(!text) return;
  const t = text.length > TTS_MAX_CHARS ? text.substring(0, TTS_MAX_CHARS) : text;
  if(t.length < 20) return; // skip tiny texts
  fetchTtsBlob(t).catch(err=>console.warn("[tts preempt]", err.message || err));
}

let ttsState = null; // {text, audio, rate, paused}

function playTts(text){
  stopTts();
  if(text.length > TTS_MAX_CHARS) text = text.substring(0, TTS_MAX_CHARS);
  ttsState = {text, rate:1.0, paused:false};
  _showTtsControls(true);
  // If already cached, start playing within user-gesture microtask (iOS-friendly).
  const cached = ttsBlobCache.get(ttsTextKey(text));
  if(cached){ _ttsPlay(cached); return; }
  // Not cached: fetch then play. On iOS cold-cache the play() may be outside user-gesture;
  // fallback: show Loading state and hope for best.
  fetchTtsBlob(text).then(_ttsPlay).catch(err=>{
    console.error("[tts] fetch failed:", err);
    alert("TTS failed: " + (err.message||err));
    stopTts();
  });
}

function _ttsPlay(url){
  if(!ttsState) return;
  const audio = new Audio(url);
  audio.playbackRate = ttsState.rate;
  audio.onended = ()=>stopTts();
  audio.onerror = (e)=>{ console.warn("[tts] audio error", e); stopTts(); };
  ttsState.audio = audio;
  _updateTtsControls();
  audio.play().catch(err=>{
    console.warn("[tts] play() rejected:", err);
    // Likely iOS user-gesture expired. Let the controls stay so user can retry.
  });
}

function togglePauseTts(){
  if(!ttsState || !ttsState.audio) return;
  if(ttsState.paused){ ttsState.audio.play(); ttsState.paused=false; }
  else { ttsState.audio.pause(); ttsState.paused=true; }
  _updateTtsControls();
}
function cycleTtsSpeed(){
  if(!ttsState) return;
  const rates = [1.0, 1.25, 1.5, 2.0, 0.85];
  const i = rates.indexOf(ttsState.rate);
  ttsState.rate = rates[(i+1) % rates.length];
  if(ttsState.audio) ttsState.audio.playbackRate = ttsState.rate;
  _updateTtsControls();
}
function stopTts(){
  if(ttsState && ttsState.audio){ try{ ttsState.audio.pause(); }catch{} }
  ttsState = null;
  document.querySelectorAll(".tts-controls").forEach(b=>b.remove());
}
function _showTtsControls(loading){
  document.querySelectorAll(".tts-controls").forEach(b=>b.remove());
  const bar = mk("div","tts-controls");
  const pause = mk("button","tts-btn"); pause.id="ttsPause"; pause.textContent=loading?"\u25CB":"\u23F8"; pause.onclick=togglePauseTts; pause.title="Pause/Resume";
  const speed = mk("button","tts-btn"); speed.id="ttsSpeed"; speed.textContent="1x"; speed.onclick=cycleTtsSpeed; speed.title="Cycle speed";
  const stop  = mk("button","tts-btn tts-stop"); stop.textContent="\u23F9"; stop.onclick=stopTts; stop.title="Stop";
  bar.appendChild(pause); bar.appendChild(speed); bar.appendChild(stop);
  document.body.appendChild(bar);
}
function _updateTtsControls(){
  const p = document.getElementById("ttsPause");
  if(p) p.textContent = (ttsState && ttsState.audio) ? (ttsState.paused ? "\u25B6" : "\u23F8") : "\u25CB";
  const s = document.getElementById("ttsSpeed");
  if(s && ttsState) s.textContent = ttsState.rate + "x";
}

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


// ── Open-in-Gmail / Mail-app intent log (fire-and-forget) ──
// Cross-channel dedup hint for camoHero send pipeline. Best-effort; if the
// fetch fails the navigation still happens.
function logExternalSendIntent(channel, to, cc, subject, body) {
  try {
    fetch(apiUrl("/api/email-draft/log-intent"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      keepalive: true,
      body: JSON.stringify({
        sessionId: (typeof session !== "undefined" && session && session.id) || "",
        channel,
        to: to || "",
        cc: cc || "",
        subject: subject || "",
        body: body || "",
      }),
    }).catch(()=>{});
  } catch {}
}

// ── Email draft action card (from mcp__crankhero-draft__draft_email) ──
function addEmailDraft(msg){
  const to = msg.to || "";
  const cc = msg.cc || "";
  const subject = msg.subject || "";
  const body = msg.body || "";
  const threadId = msg.thread_id || "";
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];

  const d = mk("div","msg email-draft");
  const label = mk("div","draft-label");
  label.textContent = threadId ? "\u21A9 Reply (threads into existing conversation)" : "\u2709 New email";
  const hdr = mk("div","draft-hdr");
  const addRow = (k,v)=>{ if(!v) return;
    const ek=mk("span","k"); ek.textContent=k;
    const ev=mk("span","v"); ev.textContent=v;
    hdr.appendChild(ek); hdr.appendChild(ev);
  };
  addRow("To:", to);
  if(cc) addRow("Cc:", cc);
  addRow("Subject:", subject);

  const bodyEl = mk("div","draft-body"); bodyEl.textContent = body;

  // Attachments (if any) — read-only display; sent via the camoHero Send button.
  let attachmentsEl = null;
  if (attachments.length) {
    attachmentsEl = mk("div", "draft-attachments attachments-list");
    const lbl = mk("div", "att-label"); lbl.textContent = "\u{1F4CE} " + attachments.length + " attachment" + (attachments.length === 1 ? "" : "s");
    attachmentsEl.appendChild(lbl);
    attachments.forEach((p) => {
      const row = mk("a", "att-row att-link");
      const name = String(p).split("/").pop();
      row.textContent = "📎 " + name;
      row.title = p;
      const _ext = p.split(".").pop().toLowerCase();
      const _viewable = ["pdf","png","jpg","jpeg","gif","svg"].includes(_ext);
      if (_viewable) {
        row.href = "#";
        row.onclick = (e) => { e.preventDefault(); openFileModal(name, p); };
      } else {
        row.href = apiUrl("/api/file?path=" + encodeURIComponent(p));
        row.target = "_blank";
        row.rel = "noopener noreferrer";
      }
      attachmentsEl.appendChild(row);
    });
    const note = mk("div", "att-note");
    note.textContent = "Attachments are only included via the Send button. Open-in-Gmail can\u2019t pre-attach files (Gmail compose URL doesn\u2019t support it).";
    attachmentsEl.appendChild(note);
  }

  const toEnc = encodeURIComponent(to);
  const ccEnc = encodeURIComponent(cc);
  const subEnc = encodeURIComponent(subject);
  const bodyEnc = encodeURIComponent(body);
  const prefillLen = toEnc.length + ccEnc.length + subEnc.length + bodyEnc.length;

  const actions = mk("div","draft-actions");

  // Primary: Open in Gmail. Two modes:
  //   * No threadId  → opens compose with subject/body prefilled.
  //                    iOS: googlegmail://co?... (Gmail app).
  //                    Else: https://mail.google.com/mail/?view=cm... in new tab.
  //   * threadId set → opens that *thread* so the user taps Reply on it (the
  //                    only way to actually thread the message — Gmail web URL
  //                    has no compose-with-thread parameter). Body is auto-copied
  //                    to clipboard so paste-after-Reply is one tap.
  const gmailComposeWeb = `https://mail.google.com/mail/?view=cm&fs=1&to=${toEnc}&su=${subEnc}&body=${bodyEnc}` + (cc ? `&cc=${ccEnc}` : "");
  const gmailComposeIos = `googlegmail://co?to=${toEnc}&subject=${subEnc}&body=${bodyEnc}` + (cc ? `&cc=${ccEnc}` : "");
  const gmailThreadWeb = threadId ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}` : "";
  const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const gmailBtn = mk("a","draft-btn primary");
  if (threadId) {
    // Reply-to-thread mode: copy body, navigate to the thread (or to a
    // search for it on iOS — Gmail app has no thread-id scheme, and iOS
    // Brave/Chrome don't honor Apple Universal Links so the https URL
    // would just load Gmail mobile web instead of opening the app).
    if (isIOS) {
      const subjForSearch = subject.replace(/^\s*Re:\s*/i, "").slice(0, 90);
      const iosSearchUrl = `googlegmail://search?query=${encodeURIComponent(subjForSearch)}`;
      gmailBtn.href = iosSearchUrl;
      gmailBtn.textContent = "\u{1F4E8} Find thread in Gmail app (body copied)";
    } else {
      gmailBtn.href = gmailThreadWeb;
      gmailBtn.target = "_blank";
      gmailBtn.rel = "noopener noreferrer";
      gmailBtn.textContent = "\u{1F4E8} Reply in Gmail (body copied)";
    }
    gmailBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(body); } catch {}
      logExternalSendIntent("reply_in_gmail", to, cc, subject, body);
    });
  } else if (isIOS) {
    gmailBtn.href = gmailComposeIos;
    gmailBtn.textContent = "\u{1F4E8} Open in Gmail app";
    gmailBtn.addEventListener("click", () => logExternalSendIntent("open_in_gmail_ios", to, cc, subject, body));
  } else {
    gmailBtn.href = gmailComposeWeb;
    gmailBtn.target = "_blank";
    gmailBtn.rel = "noopener noreferrer";
    gmailBtn.textContent = "\u{1F4E8} Open in Gmail";
    gmailBtn.addEventListener("click", () => logExternalSendIntent("open_in_gmail_web", to, cc, subject, body));
  }

  const copyBodyBtn = mk("button","draft-btn");
  copyBodyBtn.textContent = "\u{1F4CB} Copy body";
  copyBodyBtn.onclick = async ()=>{
    try {
      await navigator.clipboard.writeText(body);
      copyBodyBtn.textContent = "\u2713 Copied";
    } catch {
      const ta = document.createElement("textarea");
      ta.value = body; ta.style.position="fixed"; ta.style.opacity="0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); copyBodyBtn.textContent = "\u2713 Copied"; }
      catch { copyBodyBtn.textContent = "Copy failed"; }
      ta.remove();
    }
    setTimeout(()=>{ copyBodyBtn.textContent = "\u{1F4CB} Copy body"; }, 1500);
  };

  const copySubjBtn = mk("button","draft-btn");
  copySubjBtn.textContent = "\u{1F4CB} Subject";
  copySubjBtn.onclick = async ()=>{
    try { await navigator.clipboard.writeText(subject); copySubjBtn.textContent = "\u2713 Copied"; }
    catch { copySubjBtn.textContent = "Copy failed"; }
    setTimeout(()=>{ copySubjBtn.textContent = "\u{1F4CB} Subject"; }, 1500);
  };

  const mailtoBtn = mk("button","draft-btn");
  mailtoBtn.textContent = "\u{1F4E7} Mail app";
  mailtoBtn.onclick = ()=>{
    logExternalSendIntent("mailto", to, cc, subject, body);
    const url = `mailto:${to}?subject=${subEnc}&body=${bodyEnc}` + (cc ? `&cc=${ccEnc}` : "");
    window.location.href = url;
  };

  // camoHero Send button — only renders when this draft was produced in a camoHero session.
  // Two-tap confirm (mobile-fastest, mirrors how the rest of the cards behave).
  // POSTs to /api/email-draft/send which shells out to camoHero send_gmail_email.py.
  if (msg.project === "camoHero") {
    const sendBtn = mk("button","draft-btn primary send");
    const SEND_LABEL = "\u{1F680} Send (camofiles)";
    sendBtn.textContent = SEND_LABEL;
    const forceBtn = mk("button", "draft-btn force");
    forceBtn.textContent = "\u26A0 Force send";
    forceBtn.style.display = "none";
    const errorEl = mk("div", "send-error-panel"); errorEl.style.display = "none";
    let armed = false, sending = false;
    sendBtn.onclick = async () => {
      if (sending) return;
      if (!armed) {
        armed = true;
        sendBtn.textContent = "\u26A0 Tap again to send";
        sendBtn.classList.add("armed");
        setTimeout(() => {
          if (armed && !sending) {
            armed = false;
            sendBtn.classList.remove("armed");
            sendBtn.textContent = SEND_LABEL;
          }
        }, 4000);
        return;
      }
      sending = true;
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending\u2026";
      sendBtn.classList.remove("armed");
      try {
        const r = await fetch(apiUrl("/api/email-draft/send"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: (session && session.id) || "", to, cc, subject, body, threadId, attachments }),
        });
        const data = await r.json();
        if (data.ok) {
          sendBtn.textContent = "\u2713 Sent";
          sendBtn.classList.add("sent");
          errorEl.style.display = "none";
        } else {
          sendBtn.textContent = "\u2717 Blocked — see below";
          sendBtn.classList.add("failed");
          // stdout has the full pre-send summary with all BLOCKED lines
          const fullErr = (data.stdout || "").trim() || data.error || data.stderr || "send failed";
          errorEl.innerHTML = '<div class="sep-title">Why it was blocked</div>' + esc(fullErr);
          errorEl.style.display = "";
          forceBtn.style.display = "";
          setTimeout(() => {
            sending = false; armed = false;
            sendBtn.disabled = false;
            sendBtn.textContent = SEND_LABEL;
            sendBtn.classList.remove("failed");
          }, 3000);
        }
      } catch (e) {
        sendBtn.textContent = "\u2717 Network";
        sendBtn.classList.add("failed");
        sendBtn.title = e.message || "network error";
        setTimeout(() => {
          sending = false; armed = false;
          sendBtn.disabled = false;
          sendBtn.textContent = SEND_LABEL;
          sendBtn.classList.remove("failed");
        }, 6000);
      }
    };
    let forceArmed = false, forceSending = false;
    forceBtn.onclick = async () => {
      if (forceSending) return;
      if (!forceArmed) {
        forceArmed = true;
        forceBtn.textContent = "\u26A0 Tap again to FORCE";
        forceBtn.classList.add("armed");
        setTimeout(() => {
          if (forceArmed && !forceSending) {
            forceArmed = false;
            forceBtn.classList.remove("armed");
            forceBtn.textContent = "\u26A0 Force send";
          }
        }, 4000);
        return;
      }
      forceSending = true;
      forceBtn.disabled = true;
      forceBtn.textContent = "Forcing\u2026";
      forceBtn.classList.remove("armed");
      try {
        const r = await fetch(apiUrl("/api/email-draft/send"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: (session && session.id) || "", to, cc, subject, body, threadId, attachments, force: true }),
        });
        const data = await r.json();
        if (data.ok) {
          forceBtn.textContent = "\u2713 Sent (forced)";
          forceBtn.classList.add("sent");
          sendBtn.style.display = "none";
        } else {
          forceBtn.textContent = "\u2717 " + (data.error ? data.error.slice(0, 40) : "Failed");
          forceBtn.classList.add("failed");
          forceBtn.title = data.error || data.stderr || data.stdout || "force send failed";
          setTimeout(() => {
            forceSending = false; forceArmed = false;
            forceBtn.disabled = false;
            forceBtn.textContent = "\u26A0 Force send";
            forceBtn.classList.remove("failed");
          }, 6000);
        }
      } catch (e) {
        forceBtn.textContent = "\u2717 Network";
        forceBtn.classList.add("failed");
        forceBtn.title = e.message || "network error";
        setTimeout(() => {
          forceSending = false; forceArmed = false;
          forceBtn.disabled = false;
          forceBtn.textContent = "\u26A0 Force send";
          forceBtn.classList.remove("failed");
        }, 6000);
      }
    };

    actions.appendChild(sendBtn);
    actions.appendChild(forceBtn);
    actions.appendChild(errorEl);
  }

  actions.appendChild(gmailBtn);
  actions.appendChild(copyBodyBtn);
  actions.appendChild(copySubjBtn);
  actions.appendChild(mailtoBtn);

  d.appendChild(label);
  d.appendChild(hdr);
  d.appendChild(bodyEl);
  if (attachmentsEl) d.appendChild(attachmentsEl);
  d.appendChild(actions);

  // Expand button if body is tall — appended after DOM insert so we can measure.
  chat.appendChild(d);
  setTimeout(()=>{
    if(bodyEl.scrollHeight > 180 + 10){
      const toggle = mk("button","draft-body-toggle");
      toggle.textContent = "show more";
      toggle.onclick = ()=>{
        bodyEl.classList.toggle("expanded");
        toggle.textContent = bodyEl.classList.contains("expanded") ? "show less" : "show more";
      };
      d.insertBefore(toggle, actions);
    }
  }, 0);

  scrollToBottomForce();
}

init();

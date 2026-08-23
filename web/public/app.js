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
  // Outbox items are tagged with the session they were typed in (sid). Only
  // flush items belonging to THIS session — flushing the global outbox into
  // whatever chat reconnected first delivered messages to the WRONG chat
  // (real incident 2026-07-07: a queued message landed in another session).
  // Untagged (legacy) items keep the old behavior so nothing is stranded.
  const sid=session&&session.id;
  for(const item of outbox){
    if(item.sid&&sid&&item.sid!==sid) continue;
    try{ws.send(JSON.stringify({type:"prompt",client_id:item.id,text:item.text,images:item.images||[],resend:true}))}catch{}
  }
}
// ---- NO-LOSS net (2026-07-07, images added 2026-08-14) ----
// Any outbox item still unacked after a few seconds gets POSTed to
// /api/outbox-capture, which makes it durable in the session's server-side
// queue immediately (plain HTTP works when the WS is dead or a zombie).
// On ok:true the server owns delivery, so we drop the item locally.
// Images: sent as base64 in the JSON body. Server route has a 20mb limit and
// runs the same saveUploadedImage flow the WS handler does. `keepalive` is
// only enabled for small bodies — browsers cap keepalive at ~64KB.
function captureOutbox(){
  const now=Date.now();
  for(const item of outbox.slice()){
    if(now-(item.ts||0)<4000) continue;             // give the WS path first shot
    const sid=item.sid||localStorage.getItem("llmt_session");
    if(!sid||!item.text) continue;
    // Stuck > 30s = network genuinely down. Flip the chip to "failed" so the
    // user can see + tap to retry. Retries also happen automatically each poll.
    if(now-(item.ts||0)>30000) setUserMsgState(item.id,"failed");
    const body={sessionId:sid,client_id:item.id,text:item.text};
    if(item.images&&item.images.length) body.images=item.images;
    const bodyStr=JSON.stringify(body);
    fetch(apiUrl("/api/outbox-capture"),{
      method:"POST",headers:{"Content-Type":"application/json"},
      keepalive: bodyStr.length<60000,
      body: bodyStr
    }).then(r=>r.ok?r.json():null).then(d=>{
      if(d&&d.ok){
        outbox=outbox.filter(x=>x.id!==item.id);saveOutbox();
        setUserMsgState(item.id,"sent");
      }
    }).catch(()=>{});
  }
}
setInterval(captureOutbox,6000);
// Immediate capture on load: pick up items stranded from a prior tab-death
// without waiting for the first 6s tick.
setTimeout(captureOutbox,500);
// ---- Send-state chip helpers ----
// Managed states for the small dot in the corner of user bubbles:
//   "sending" — WS send fired, awaiting ack (gray, pulsing)
//   "queued"  — WS dead; sits in local outbox waiting to ship (amber)
//   "failed"  — stuck > 30s; tap-to-retry (red !)
//   "sent"    — server has it; auto-fades in 1.2s (green)
// No-op if the bubble isn't in the DOM (history re-renders skip it).
function setUserMsgState(clientId, state){
  if(!clientId) return;
  const el=chat.querySelector('.msg.user[data-client-id="'+CSS.escape(clientId)+'"] .msg-state');
  if(!el) return;
  el.dataset.state=state;
  el.classList.remove("hidden","st-sending","st-queued","st-failed","st-sent");
  el.textContent=""; el.onclick=null; el.title="";
  if(state==="sending"){el.classList.add("st-sending"); el.title="Sending…";}
  else if(state==="queued"){el.classList.add("st-queued"); el.title="Queued — waiting for connection";}
  else if(state==="failed"){
    el.classList.add("st-failed"); el.textContent="!"; el.title="Send failed — tap to retry";
    el.onclick=(e)=>{e.stopPropagation();retryOutboxItem(clientId);};
  }
  else if(state==="sent"){
    el.classList.add("st-sent"); el.title="Sent";
    setTimeout(()=>{try{el.classList.add("hidden");}catch{}},1200);
  }
  else el.classList.add("hidden");
}
// User tapped a failed chip. Force an immediate retry: WS if live, else HTTP.
function retryOutboxItem(clientId){
  const it=outbox.find(x=>x.id===clientId);
  if(!it) return;
  setUserMsgState(clientId,"sending");
  if(ws&&ws.readyState===1){
    try{ws.send(JSON.stringify({type:"prompt",client_id:it.id,text:it.text,images:it.images||[],resend:true}));}catch{}
  } else {
    it.ts=0; // force stale so captureOutbox picks it up this tick
    captureOutbox();
  }
}
// ---- Pagehide / beforeunload beacon flush ----
// Last-ditch flush before the tab dies. sendBeacon guarantees delivery even
// during page destruction. Text-only items only — beacon body cap is small
// and images can't reliably fit. Image items persist in localStorage and get
// captured on next page load (immediate captureOutbox above).
function flushOutboxToBeacon(){
  try{
    const sid=(session&&session.id)||localStorage.getItem("llmt_session");
    if(!sid) return;
    for(const item of outbox){
      if(!item.text) continue;
      if(item.images&&item.images.length) continue;
      const body=JSON.stringify({
        sessionId:sid,client_id:item.id,text:item.text,source:"pagehide-beacon"
      });
      try{navigator.sendBeacon(apiUrl("/api/outbox-capture"),new Blob([body],{type:"application/json"}));}catch{}
    }
  }catch{}
}
window.addEventListener("pagehide",flushOutboxToBeacon);
window.addEventListener("beforeunload",flushOutboxToBeacon);
function saveInputSelection(){try{localStorage.setItem("llmt_draft_sel",JSON.stringify({s:inp.selectionStart,e:inp.selectionEnd}))}catch{}}
// ── Scroll UX (2026-08-14 redesign) ──
// The old code persisted a raw pixel `top` and re-applied it after every
// re-render — a race that landed the chat mid-transcript whenever reflow
// changed geometry (image loads, address-bar collapse, new messages).
// Replaced with:
//   • last_seen_ts persisted PER-SESSION, updated when a bubble sits in
//     view via IntersectionObserver (meaning survives reflow; pixels don't)
//   • Default landing = newest (bottom) — that's what a chat opener wants
//   • Unread chip surfaces "N new since last visit — Show what you missed"
//     when the newest server ts exceeds the persisted last_seen_ts
//   • Jump-to-bottom FAB is always available when scrolled up
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
let _lastSeenTs=0;
function _lastSeenKey(){return"llmt_last_seen:"+((session&&session.id)||"_")}
function _loadLastSeen(){
  try{_lastSeenTs=parseInt(localStorage.getItem(_lastSeenKey())||"0",10)||0}catch{_lastSeenTs=0}
}
function _saveLastSeen(ts){
  if(!ts||ts<=_lastSeenTs) return;
  _lastSeenTs=ts;
  try{localStorage.setItem(_lastSeenKey(),String(ts))}catch{}
  _updateFabVisibility();
}
let _msgObserver=null;
function _setupMsgObserver(){
  if(_msgObserver||!("IntersectionObserver" in window)) return;
  _msgObserver=new IntersectionObserver((entries)=>{
    for(const e of entries){
      if(!e.isIntersecting) continue;
      const ts=parseInt(e.target.dataset.ts||"0",10);
      if(ts>_lastSeenTs) _saveLastSeen(ts);
    }
  },{root:chat,threshold:0.5});
}
function _observeMessage(el){
  if(!_msgObserver||!el||!el.dataset||!el.dataset.ts) return;
  try{_msgObserver.observe(el)}catch{}
}
let _chatMO=null;
function _startChatMutationObserver(){
  if(_chatMO||!chat) return;
  _chatMO=new MutationObserver((mutations)=>{
    for(const m of mutations){
      if(m.type==="attributes"&&m.target.dataset&&m.target.dataset.ts){
        _observeMessage(m.target);
      } else if(m.type==="childList"){
        for(const node of m.addedNodes){
          if(node.nodeType!==1) continue;
          if(node.classList&&node.classList.contains("msg")&&node.dataset&&node.dataset.ts){
            _observeMessage(node);
          }
          if(node.querySelectorAll) node.querySelectorAll(".msg[data-ts]").forEach(_observeMessage);
        }
      }
    }
  });
  _chatMO.observe(chat,{childList:true,subtree:true,attributes:true,attributeFilter:['data-ts']});
}
function _maxRenderedTs(){
  let max=0;
  chat.querySelectorAll(".msg[data-ts]").forEach(el=>{
    const ts=parseInt(el.dataset.ts||"0",10);
    if(ts>max) max=ts;
  });
  return max;
}
function _countUnreadSince(){
  if(!_lastSeenTs) return 0;
  let n=0;
  chat.querySelectorAll(".msg[data-ts]").forEach(el=>{
    const ts=parseInt(el.dataset.ts||"0",10);
    if(ts>_lastSeenTs) n++;
  });
  return n;
}
// The intentional replacement for the old `setTimeout(restoreChatScroll,0)`.
// Called after history renders (from the WS "history" handler). Rules:
//   1) Default landing = newest (bottom). Race-free — one rAF, deterministic scroll.
//   2) Surface the "Show what you missed" chip ONLY when there is unread
//      activity that would require scrolling UP to see (i.e., the first
//      unread message is off-screen above the viewport). A chip that says
//      "3 new" while those 3 are already visible reads as noise.
function resolveInitialScroll(){
  _loadLastSeen();
  requestAnimationFrame(()=>{
    scrollToBottomForce();
    _hideUnreadChip();
    if(_lastSeenTs){
      const firstUnread=Array.from(chat.querySelectorAll(".msg[data-ts]")).find(el=>{
        const ts=parseInt(el.dataset.ts||"0",10);
        return ts>_lastSeenTs;
      });
      if(firstUnread){
        const chatRect=chat.getBoundingClientRect();
        const firstRect=firstUnread.getBoundingClientRect();
        if(firstRect.top<chatRect.top){
          const n=_countUnreadSince();
          if(n>0) _showUnreadChip(n, firstUnread);
        }
      }
    }
    _updateFabVisibility();
  });
}
// ── Unread chip + jump-to-bottom FAB ──
let _unreadChipEl=null, _fabEl=null, _unreadAnchor=null;
function _ensureFab(){
  if(_fabEl) return _fabEl;
  _fabEl=document.createElement("button");
  _fabEl.className="chat-fab hidden";
  _fabEl.setAttribute("aria-label","Jump to newest");
  _fabEl.innerHTML='<span class="fab-arrow">↓</span><span class="fab-count"></span>';
  _fabEl.onclick=()=>{
    scrollToBottomForce();
    _saveLastSeen(_maxRenderedTs());
    _hideUnreadChip();
    _updateFabVisibility();
  };
  document.body.appendChild(_fabEl);
  return _fabEl;
}
function _ensureUnreadChip(){
  if(_unreadChipEl) return _unreadChipEl;
  _unreadChipEl=document.createElement("button");
  _unreadChipEl.className="unread-chip hidden";
  _unreadChipEl.onclick=()=>_jumpToFirstUnread();
  document.body.appendChild(_unreadChipEl);
  return _unreadChipEl;
}
// Bind the first-unread anchor at chip-show time. If we recomputed at click
// time, the IntersectionObserver would have already updated _lastSeenTs to
// the newest (because bottom messages became visible on open) — no anchor
// would be found, the jump would silently no-op.
function _showUnreadChip(n, anchor){
  const el=_ensureUnreadChip();
  el.textContent="↑ "+n+" new since last visit — Show what you missed";
  el.classList.remove("hidden");
  _unreadAnchor = anchor || null;
}
function _hideUnreadChip(){
  if(_unreadChipEl) _unreadChipEl.classList.add("hidden");
  _unreadAnchor = null;
}
function _jumpToFirstUnread(){
  const anchor = _unreadAnchor;
  if(!anchor || !anchor.parentNode){_hideUnreadChip();return;}
  let divider = chat.querySelector(".unread-divider");
  if(!divider){
    divider = mk("div","unread-divider");
    divider.textContent="── New ──";
    anchor.parentNode.insertBefore(divider, anchor);
  }
  // Scroll the DIVIDER into view (not the anchor). With block:"start" the
  // anchor sits just under the divider — you land on "New" as your header
  // and the first unread message is the next thing you see.
  try{divider.scrollIntoView({behavior:"smooth",block:"start"});}catch{divider.scrollIntoView();}
  _hideUnreadChip();
}
function _updateFabVisibility(){
  const fab=_ensureFab();
  const nearBottom=(chat.scrollHeight-chat.scrollTop-chat.clientHeight)<100;
  if(nearBottom) fab.classList.add("hidden"); else fab.classList.remove("hidden");
  const cnt=_countUnreadSince();
  const c=fab.querySelector(".fab-count");
  if(c) c.textContent=cnt>0?String(cnt):"";
}

function setInputFromHistory(text){
  inp.value=text;
  inp.style.height="44px";
  inp.style.height=Math.min(inp.scrollHeight,140)+"px";
  // Move cursor to end
  const len=inp.value.length;
  inp.setSelectionRange(len,len);
  _updateClearBtn();
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
const _provExpanded = { claude: false, openai: false, google: false, deepseek: false };

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
const badge=document.getElementById("badge");
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

  // Start the intersection + mutation observers that keep last_seen_ts current.
  // Idempotent — safe to call before any chat content exists.
  try { _setupMsgObserver(); _startChatMutationObserver(); } catch (e) { console.warn("[scroll-obs] init failed:", e.message); }
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
// (app-session-state.js)
// (app-input.js)
function loadMore(){
  if(ws&&ws.readyState===1&&historyOffset>0) ws.send(JSON.stringify({type:"load_more",before:historyOffset,count:20}));
}
function interrupt(){
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:"interrupt"}));
  // Server-side interrupt also disarms any pending wake (2026-08-23 fix) —
  // re-poll immediately instead of waiting up to 5s for the countdown to
  // catch up, so tapping Stop visibly clears the countdown right away.
  if(typeof _pollWakeStatus === "function") setTimeout(_pollWakeStatus, 300);
}

// ── DOM helpers ──
// (message-render fns moved to app-render.js)
// (app-permcards.js)
// (app-msg-helpers.js)
// (app-status.js)
// (app-ui-misc.js)
function updateSendButton(){
  if(sendBtn){sendBtn.disabled=!isSynced}
}

function _updateClearBtn(){
  const wrap=inp.parentElement;
  if(wrap&&wrap.classList) wrap.classList.toggle("has-text", inp.value.length>0);
}
function clearInput(){
  _clearInput();
  _updateClearBtn();
  try{ inp.focus(); }catch{}
}
inp.addEventListener("input",()=>{
  autoResizeInput(inp);
  localStorage.setItem("llmt_draft",inp.value);
  _updateClearBtn();
});
// Restore draft on load
try{const d=localStorage.getItem("llmt_draft");if(d){inp.value=d;autoResizeInput(inp);}}catch{}
_updateClearBtn();
// Phase 1: restore selection, sidebar/drawer state, file filter, search query
try{
  const sel=JSON.parse(localStorage.getItem("llmt_draft_sel")||"null");
  if(sel&&typeof sel.s==="number"){inp.setSelectionRange(sel.s,sel.e||sel.s)}
}catch{}
try{
  const isMobile=window.innerWidth<=768;
  // Sidebar is overlay (not permanent) at ≤1023px — covers iPhone and iPad portrait.
  // Don't auto-open it there: David explicitly wants to see the chat, not the session list.
  const sidebarIsOverlay=window.innerWidth<=1023;
  if(!isMobile&&localStorage.getItem("llmt_drawer_open")==="true"){
    document.getElementById("drawer").classList.remove("hidden");
  }
  if(!sidebarIsOverlay&&localStorage.getItem("llmt_sidebar_open")==="true"){
    document.getElementById("sidebar").classList.add("show");
  }
  // (fileFilter restore moved to app-permcards.js — it owns the `let fileFilter` binding;
  //  assigning here at parse time created an orphan window.fileFilter the later `let` shadowed)
  const sq=localStorage.getItem("llmt_drawer_search");
  if(sq){const el=document.getElementById("drawerSearch");if(el)el.value=sq}
}catch{}
// Save input selection on cursor move
document.addEventListener("selectionchange",()=>{if(document.activeElement===inp)saveInputSelection()});
inp.addEventListener("click",saveInputSelection);
inp.addEventListener("keyup",saveInputSelection);
// Chat scroll: keep sticky detection + FAB visibility in sync. The old
// pixel-position persistence is gone (last_seen_ts is what we persist now,
// via IntersectionObserver — see resolveInitialScroll above).
chat.addEventListener("scroll",()=>{updateStickyFromScroll();_updateFabVisibility();});
// Save drawer search query
const dsEl=document.getElementById("drawerSearch");
if(dsEl)dsEl.addEventListener("input",()=>{try{localStorage.setItem("llmt_drawer_search",dsEl.value)}catch{}});
// Chat search listeners
const chatSearchInput=document.getElementById("chatSearchInput");
if(chatSearchInput){
  chatSearchInput.addEventListener("input",e=>runChatSearch(e));
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
// (bubble context menu moved to app-bubble-menu.js)

// ── Task Board (orchestrator proxy) ──
let taskCache=[], taskFilter="actionable";
// (task-board fns moved to app-tasks.js)
// (long-press + contextmenu wiring moved to app-bubble-menu.js)

// Defer bootstrap until ALL app-*.js modules have loaded. app.js is the first
// script; app-sidebar.js (loadSessions) and others load AFTER it, so calling
// init() at parse time raced loadSessions() -> 'loadSessions is not defined'.
// DOMContentLoaded fires only after every parser-blocking script has executed.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
// (persisted file-attachment tray render moved to app-drawer.js — calling it here at parse
//  time threw a swallowed ReferenceError because app-drawer.js loads after app.js)

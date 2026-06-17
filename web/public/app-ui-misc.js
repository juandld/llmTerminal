// Misc UI: overflow menu, chat-search, summary, copy, notifications, mk/esc — classic script, shares global scope with app.js.
// Extracted (refactor 2026-06-10).

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

// Intercept clicks on file:// links in chat messages — those are produced by
// skills (e.g. /generate-takes) that render comparison tables with each cell
// linking to a generated file. Audio tables: seed the existing playback queue
// with EVERY audio link in the same message (so tracks auto-advance and the
// now-playing strip / prev / next / pause buttons all work uniformly), start
// at the clicked one. Everything else (pdf, image, text): open the file-preview
// modal. Delegated — survives DOM re-renders.
const _AUDIO_EXT = new Set(["mp3","wav","m4a","ogg","webm","aac","flac","opus"]);
function _decodeFileHref(href){
  let p = decodeURIComponent(href || "");
  p = p.replace(/^file:\/\/\/?/, "/").replace(/^\/+/, "/");
  return p.startsWith("/") ? p : null;
}
chat.addEventListener("click", (e) => {
  const a = e.target && e.target.closest && e.target.closest('a[href^="file:"]');
  if (!a) return;
  e.preventDefault();
  const fp = _decodeFileHref(a.getAttribute("href"));
  if (!fp) return;
  const ext = (fp.split(".").pop() || "").toLowerCase();
  const title = a.textContent.trim() || fp.split("/").pop();
  if (_AUDIO_EXT.has(ext)) {
    // Build the queue from every audio file:// link in the SAME assistant
    // message (the table), preserving render order. Then play from idx.
    const msg = a.closest(".msg") || chat;
    const items = [];
    let clickedIdx = -1;
    for (const link of msg.querySelectorAll('a[href^="file:"]')) {
      const lp = _decodeFileHref(link.getAttribute("href"));
      if (!lp) continue;
      const lext = (lp.split(".").pop() || "").toLowerCase();
      if (!_AUDIO_EXT.has(lext)) continue;
      const id = "tbl:" + lp;
      if (link === a) clickedIdx = items.length;
      items.push({ id, url: apiUrl("/api/file?path=" + encodeURIComponent(lp)), title: link.textContent.trim() || lp.split("/").pop() });
    }
    if (items.length && typeof _playCurrent === "function") {
      _playbackQueue = items;
      _playbackIndex = Math.max(0, clickedIdx);
      _playCurrent();
      return;
    }
    // Fall-through if playback infra isn't loaded yet — open modal as backup.
  }
  if (typeof openFileModal === "function") openFileModal(title, fp);
});

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

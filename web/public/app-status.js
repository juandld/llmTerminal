// Status/busy indicator + browser-poll controls — classic script, shares global scope with app.js.
// Extracted (refactor 2026-06-10).

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

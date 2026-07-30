// Status/busy indicator + browser-poll controls — classic script, shares global scope with app.js.
// Extracted (refactor 2026-06-10).

// `(pointer:fine) and (hover:hover) and (min-width:1280px)` — desktop only.
// iPad 11" landscape (1194px) and Magic Keyboard trackpad still report pointer:fine,
// so the pointer test alone wasn't enough — David was getting the soft keyboard popping
// on every chat switch. Adding the min-width gate excludes both iPad orientations.
const _DESKTOP_FOCUS_MQ = '(pointer:fine) and (hover:hover) and (min-width:1280px)';
function setBusy(b){
  const wasBusy = busy;
  // Keep Send visible while busy — tapping it queues (send() detects busy and
  // pushes to messageQueue). Hiding the button on mobile stranded users with
  // no way to queue (no hardware Enter). Show Stop alongside so interrupt is
  // still one-tap. Only isSynced disables the button now.
  // NOTE: .btn-stop has display:none in styles.css, so `style.display=""` never
  // unhid it — Stop was permanently invisible. Set inline-block explicitly.
  busy=b;sendBtn.disabled=!isSynced;sendBtn.style.display="";sendBtn.textContent=b?"Queue":"Send";stopBtn.style.display=b?"inline-block":"none";
  if(!b){
    // Only refocus when a turn just ended (true→false) — not on history load /
    // chat switch where wasBusy was already false. Pre-fix this fired on every
    // chat switch and popped the soft keyboard on iPad.
    if(wasBusy && window.matchMedia(_DESKTOP_FOCUS_MQ).matches) inp.focus();
    // Drain queue — ONLY items belonging to the current session. A queued
    // message tagged with chat A's session id must never fire into chat B
    // (2026-07-03 bug: opening a new chat drained the previous chat's queue
    // into whichever WS was now attached). Belt-and-suspenders: teardown
    // already drops old-session items, but this guard makes the invariant
    // local to the drain site so future refactors can't reintroduce the leak.
    const curSid = session?.id || null;
    while(messageQueue.length && messageQueue[0].sessionId && messageQueue[0].sessionId !== curSid){
      messageQueue.shift(); // stale — drop silently, bubble is gone with the DOM wipe
    }
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
      _updateClearBtn();
      setTimeout(send,100);
    } else {
      renderQueueCount();
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

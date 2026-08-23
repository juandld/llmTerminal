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
// WS connection status used to be its own standalone topbar dot (#ds, far
// right, separate from the autoloop dot on the left) — David: "one minute
// loop to the left flickering green, and to the right also flickering
// green... mix those two." Two independent green indicators at opposite
// ends of a crowded topbar read as redundant clutter even though they meant
// different things. Merged: setStatus() now just records WS state, and
// _renderAutoloopBtn() (below) is the single place that decides what the
// one remaining dot/label shows, with connection trouble taking priority
// over the loop label since a dead WS matters more than a loop's countdown.
let _wsStatusText = "ready";
let _wsStatusClass = "active";
function setStatus(t,s){ _wsStatusText=t; _wsStatusClass=s; _renderAutoloopBtn(); }

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

// ── Live wake countdown (2026-08-23) ──
// David: "if it's not working I need to see a countdown on the stop
// button." Before this, the ONLY visible sign that the autoloop had a
// scheduled auto-resume was my own prose claiming it — the Stop button
// itself only ever showed while a run was actively busy, so a session
// idling between wakes looked completely inert even when a resume WAS
// armed. Two timers: a slow poll (5s) hits the server for the real wakeAt
// (source of truth — this client's clock could drift), and a fast local
// tick (1s) recomputes the displayed mm:ss between polls so the countdown
// visibly moves instead of jumping in 5s steps.
let _wakePollTimer = null;
let _wakeTickTimer = null;
let _wakeAt = null; // ms epoch, or null if no wake armed
let _wakeClockSkewMs = 0; // server_time - Date.now() at last poll, corrects for client clock drift
let _autoloopIntervalMs = null; // current session's persisted autoloop setting, or null if off

async function _pollWakeStatus(){
  if(!session || !session.id) return;
  try {
    const r = await fetch(apiUrl("/api/sessions/"+session.id+"/wake"));
    const d = await r.json();
    _wakeClockSkewMs = (d.server_time || Date.now()) - Date.now();
    _wakeAt = d.armed ? d.wakeAt : null;
    _autoloopIntervalMs = d.autoloopIntervalMs || null;
  } catch {
    // Network hiccup — keep showing the last known countdown rather than
    // flashing to "no wake" on a transient failure; the next poll corrects it.
  }
  _renderWakeCountdown();
  _renderAutoloopBtn();
}

// ── Autoloop trigger button + menu (2026-08-23) ──
// David: "trigger for the loop on top... if it's green and I click it, it
// opens a menu to select intervals." Green dot reflects
// session.autoloopIntervalMs (persisted, server-recurring — see server.js
// sweepDueWakes); selecting an interval POSTs the setting, "Off" clears it
// the same way the countdown's Stop button does.
function _renderAutoloopBtn(){
  const btn = document.getElementById("autoloopBtn");
  const label = document.getElementById("autoloopLabel");
  if(!btn || !label) return;
  const on = _autoloopIntervalMs !== null;
  // "" = WS error, "thinking" = connecting/syncing/reconnecting — both are
  // more urgent than the loop label and win the display.
  const trouble = _wsStatusClass === "" || _wsStatusClass === "thinking";
  btn.classList.toggle("ws-error", _wsStatusClass === "");
  btn.classList.toggle("ws-thinking", _wsStatusClass === "thinking");
  btn.classList.toggle("active", on && !trouble);
  label.textContent = trouble ? _wsStatusText : (on ? (Math.round(_autoloopIntervalMs/60000) + "m loop") : "Loop");
  document.querySelectorAll("#autoloopMenu button[data-autoloop-ms]").forEach(b => {
    const ms = Number(b.dataset.autoloopMs) || 0;
    b.classList.toggle("active", on ? ms === _autoloopIntervalMs : ms === 0);
  });
}

function toggleAutoloopMenu(e){
  if(e) e.stopPropagation();
  const menu = document.getElementById("autoloopMenu");
  const btn = document.getElementById("autoloopBtn");
  if(!menu || !btn) return;
  const opening = menu.classList.contains("hidden");
  if(opening){
    // position:fixed — compute from the button's real viewport rect since
    // an ancestor (.topbar-nav) clips CSS-relative absolute positioning.
    const r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + "px";
    menu.style.left = r.left + "px";
  }
  menu.classList.toggle("hidden");
  btn.setAttribute("aria-expanded", opening ? "true" : "false");
}
document.addEventListener("click", (e) => {
  const wrap = document.querySelector(".autoloop-wrap");
  const menu = document.getElementById("autoloopMenu");
  if(!wrap || !menu || menu.classList.contains("hidden")) return;
  if(!wrap.contains(e.target)) menu.classList.add("hidden");
});
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("#autoloopMenu button[data-autoloop-ms]").forEach(b => {
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if(!session || !session.id) return;
      const ms = Number(b.dataset.autoloopMs) || 0;
      document.getElementById("autoloopMenu").classList.add("hidden");
      try {
        const r = await fetch(apiUrl("/api/sessions/"+session.id+"/autoloop"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intervalMs: ms || null }),
        });
        const d = await r.json();
        _autoloopIntervalMs = d.autoloopIntervalMs || null;
        _renderAutoloopBtn();
        setTimeout(_pollWakeStatus, 400); // pick up the freshly-armed wakeAt for the countdown bar too
      } catch(err) {
        console.warn("[autoloop] set failed:", err.message);
      }
    });
  });
});

function _renderWakeCountdown(){
  const bar = document.getElementById("wakeCountdown");
  const text = document.getElementById("wakeCountdownText");
  if(!bar || !text) return;
  // David: "it says auto-resume firing now but it's still working." Root
  // cause — runStarted() (run-registry.js) re-arms the NEXT autoloop wake
  // the instant a turn STARTS, not when it ends, so /api/sessions/:id/wake
  // reports the next wake as already due/overdue for the entire duration of
  // a turn that runs longer than the interval (a 1-minute loop mid a 9-minute
  // turn). The countdown then showed "firing now" nonstop while a run was
  // plainly already in flight — nothing was actually about to fire; the
  // wake can't fire until this turn ends (sweepDueWakes skips sessions with
  // a live proc). A busy run makes the countdown moot either way, so hide it
  // outright rather than show a stale/contradictory state.
  if(busy){
    bar.classList.add("hidden");
    return;
  }
  if(_wakeAt === null){
    bar.classList.add("hidden");
    return;
  }
  const remainingMs = _wakeAt - (Date.now() + _wakeClockSkewMs);
  if(remainingMs <= 0){
    text.textContent = "Auto-resume firing now…";
    bar.classList.remove("hidden");
    return;
  }
  const totalSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = String(totalSec % 60).padStart(2, "0");
  text.textContent = "Auto-resume in " + mm + ":" + ss;
  bar.classList.remove("hidden");
}

// "Resume now" — David: "I should also see the button to resume now." Fires
// the currently-armed wake immediately instead of waiting out the timer.
// Server re-arms with fireAt=now and sweeps synchronously (same code path
// the 30s interval sweep uses — see POST /api/sessions/:id/wake/fire-now).
async function fireWakeNow(){
  if(!session || !session.id) return;
  const btn = document.getElementById("wakeCountdownFireNow");
  if(btn){ btn.disabled = true; btn.textContent = "Firing…"; }
  try {
    const r = await fetch(apiUrl("/api/sessions/"+session.id+"/wake/fire-now"), { method: "POST" });
    if(!r.ok){
      const d = await r.json().catch(() => ({}));
      console.warn("[wake] fire-now failed:", d.error || r.status);
    }
  } catch(e) {
    console.warn("[wake] fire-now request failed:", e.message);
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = "Resume now"; }
    // The wake sweep queues the prompt server-side and broadcasts busy/queue
    // state over the WS almost immediately — re-poll shortly after so the
    // countdown bar clears without waiting for the next 5s cycle.
    setTimeout(_pollWakeStatus, 500);
  }
}

function startWakeCountdownPoll(){
  stopWakeCountdownPoll();
  _pollWakeStatus();
  _wakePollTimer = setInterval(_pollWakeStatus, 5000);
  _wakeTickTimer = setInterval(_renderWakeCountdown, 1000);
}
function stopWakeCountdownPoll(){
  if(_wakePollTimer){ clearInterval(_wakePollTimer); _wakePollTimer=null; }
  if(_wakeTickTimer){ clearInterval(_wakeTickTimer); _wakeTickTimer=null; }
  _wakeAt = null;
  const bar = document.getElementById("wakeCountdown");
  if(bar) bar.classList.add("hidden");
}

// ── Overflow menu ──

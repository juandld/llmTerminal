// ── Bubble context menu (long-press / right-click on chat messages) ──
// Copy + Read aloud via /api/tts (fallback: SpeechSynthesis).
// Uses mk() from app-ui-misc.js and playTts() from app-tts.js (runtime only).
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
  // Delete is offered ONLY on user bubbles that carry a client_id — that's the
  // handle the server uses to find and remove the turn (and kill the in-flight
  // agent if applicable). Two-tap confirm to prevent accidental long-press kills.
  const isUserBubble = el.classList.contains("msg") && el.classList.contains("user") && el.dataset.clientId;
  if (isUserBubble) {
    const dBtn = mk("button","bm-btn bm-btn-danger"); dBtn.dataset.act="delete"; dBtn.textContent="\u{1F5D1} Delete message";
    menu.appendChild(dBtn);
  }
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
    } else if(btn.dataset.act === "delete"){
      if(btn.dataset.confirm !== "1"){
        btn.dataset.confirm = "1";
        btn.textContent = "⚠ Tap again to delete";
        btn.classList.add("bm-confirm");
        return;
      }
      const cid = el.dataset.clientId;
      try {
        if(cid && typeof ws !== "undefined" && ws && ws.readyState === 1){
          ws.send(JSON.stringify({type:"delete_message", client_id: cid}));
        }
      } catch {}
      closeBubbleMenu();
    }
  };
  setTimeout(()=>{
    const closer=(e)=>{ if(!e.target.closest(".bubble-menu")) closeBubbleMenu(); };
    document.addEventListener("click", closer, {once:true});
    document.addEventListener("touchstart", closer, {once:true, passive:true});
  }, 50);
}

// Tap = our menu. Long-press = iOS native text-select (we don't fight it).
// touchend within MAX_TAP_MS and no scroll-like movement => synthetic tap → menu.
// Anything longer falls through, so iOS selection callout shows on its own.
(function(){
  let sx=0, sy=0, t0=0, targetEl=null;
  const MAX_TAP_MS=350, MAX_MOVE=10;
  chat.addEventListener("touchstart",(e)=>{
    if(e.touches.length!==1){ targetEl=null; return; }
    const t=e.target.closest(".msg.user, .msg.assistant .bubble, .msg.assistant");
    if(!t){ targetEl=null; return; }
    // Don't hijack interactive children (TTS speaker, voice-note play, links, buttons)
    if(e.target.closest("button, a, input, textarea, audio, video, .msg-tts-btn, .vn-play, .vn-toggle")){ targetEl=null; return; }
    sx=e.touches[0].clientX; sy=e.touches[0].clientY; t0=performance.now(); targetEl=t;
  },{passive:true});
  chat.addEventListener("touchmove",(e)=>{
    if(!targetEl) return;
    const dx=e.touches[0].clientX-sx, dy=e.touches[0].clientY-sy;
    if(Math.hypot(dx,dy)>MAX_MOVE) targetEl=null; // scroll, not a tap
  },{passive:true});
  chat.addEventListener("touchend",()=>{
    if(!targetEl) return;
    const tgt=targetEl; targetEl=null;
    if(performance.now()-t0 > MAX_TAP_MS) return; // long-press: hand off to iOS
    const fakeEv={preventDefault:()=>{},touches:[{clientX:sx,clientY:sy}],clientX:sx,clientY:sy};
    showBubbleMenu(fakeEv, tgt);
  },{passive:true});
  chat.addEventListener("touchcancel",()=>{ targetEl=null; },{passive:true});
})();

chat.addEventListener("contextmenu",(e)=>{
  const el = e.target.closest(".msg.user, .msg.assistant .bubble, .msg.assistant");
  if(!el) return;
  showBubbleMenu(e, el);
});

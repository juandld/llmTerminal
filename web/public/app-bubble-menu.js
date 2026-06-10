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

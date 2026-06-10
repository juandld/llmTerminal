// Chat message rendering for llmTerminal — classic script, shares global
// scope with app.js. Extracted (refactor 2026-06-10, app.js phase 6).

function addUser(text,imagePreviews,clientId){
  const d=mk("div","msg user");
  if(clientId) d.dataset.clientId=clientId;
  if(text) d.appendChild(document.createTextNode(text));
  if(imagePreviews){
    imagePreviews.forEach(src=>{const img=document.createElement("img");img.src=src;d.appendChild(img)});
  }
  chat.appendChild(d);scrollToBottomForce();
  return d;
}
// Mark a user bubble as awaiting its turn behind an in-progress Claude run.
function markUserMessageQueued(clientId){
  if(!clientId) return;
  const el=chat.querySelector('.msg.user[data-client-id="'+CSS.escape(clientId)+'"]');
  if(!el || el.classList.contains("queued")) return;
  el.classList.add("queued");
  const badge=mk("span","queued-badge");
  badge.textContent="queued — waiting for current turn";
  badge.title="This message has been received and will fire automatically when Claude is idle.";
  el.appendChild(badge);
}
// Render the server-side queue (messages typed/voice-noted while Claude is mid-turn)
// as user bubbles with the "queued" badge. Idempotent: dedupes by client_id (or text
// for client_id-less items like voice notes from other devices). Called whenever the
// server emits queue_state, so every tab/device shows the same pending list and the
// user has a clear visual that the message *will* be considered.
function renderPendingItems(items){
  if(!Array.isArray(items)) return;
  for(const item of items){
    if(!item || !item.text) continue;
    if(item.client_id){
      const existing=chat.querySelector('.msg.user[data-client-id="'+CSS.escape(item.client_id)+'"]');
      if(existing){
        if(!existing.classList.contains("queued")) markUserMessageQueued(item.client_id);
        continue;
      }
    } else {
      // No client_id — dedupe by text against any already-queued bubble
      const candidates=chat.querySelectorAll('.msg.user.queued');
      let dup=false;
      for(const c of candidates){
        if(c.textContent && c.textContent.includes(item.text.slice(0,40))){dup=true;break;}
      }
      if(dup) continue;
    }
    const d=mk("div","msg user queued");
    if(item.client_id) d.dataset.clientId=item.client_id;
    d.appendChild(document.createTextNode(item.text));
    const badge=mk("span","queued-badge");
    const isVoice=item.source==="voice-note";
    badge.textContent=isVoice ? "queued voice note — will fire when Claude is idle"
                              : "queued — will fire when Claude is idle";
    badge.title="Stored on the server. It will be sent automatically when the current turn finishes.";
    d.appendChild(badge);
    chat.appendChild(d);
  }
  scrollToBottomIfSticky();
}
function unmarkOldestQueuedUserMessage(text){
  // Server's queued_prompt_firing carries text but not client_id. Match the
  // oldest still-queued bubble (FIFO matches server queue order); fall back to
  // text match if FIFO is wrong (e.g. mixed-source queue).
  const all=chat.querySelectorAll('.msg.user.queued');
  let target=all[0]||null;
  if(text){
    for(const el of all){
      if(el.textContent && el.textContent.includes(text.slice(0,40))){target=el;break;}
    }
  }
  if(!target) return;
  target.classList.remove("queued");
  const b=target.querySelector(".queued-badge");
  if(b) b.remove();
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
// Renders the supervisor's contract-check wrap-up as a visually distinct
// "system context" banner — NOT a full assistant bubble. These messages are
// metadata about the session (the auto-mark-done summary) and never enter
// Claude's conversation history (they live only in messages.db; Claude resumes
// from its own session log via --resume).
function addContractCheckBanner(text){
  const d = mk("div", "msg system-context");
  const b = mk("div", "system-context-banner");
  // Strip the leading "✓ " we add server-side so the banner's own icon is the only one.
  const clean = (text || "").replace(/^\s*✓\s+/, "");
  b.innerHTML = '<span class="sc-icon">✓</span>'
              + '<span class="sc-label">task complete</span>'
              + '<span class="sc-text">' + esc(clean) + '</span>'
              + '<span class="sc-note" title="This message is local UI context only — it is NOT sent to Claude on the next turn.">UI only</span>';
  d.appendChild(b);
  const liveTs = Date.now();
  d.dataset.ts = liveTs;
  if (liveTs > lastRenderedTs) lastRenderedTs = liveTs;
  chat.appendChild(d);
  return d;
}

// Live-streaming accumulator: append token deltas into one bubble
let _liveBubble = null;
let _liveText = "";
function appendOrCreateAssistant(delta) {
  if (_liveBubble && _liveBubble.parentNode) {
    _liveText += delta;
    const b = _liveBubble.querySelector(".bubble");
    if (b) {
      // Remove TTS button, update content, re-add TTS button
      const ttsBtn = b.querySelector(".msg-tts-btn");
      if (ttsBtn) ttsBtn.remove();
      b.innerHTML = fmt(_liveText);
      const btn = mk("button","msg-tts-btn");
      btn.textContent = "\u{1F50A}";
      btn.title = "Read aloud";
      btn.onclick = (e) => { e.stopPropagation(); playTts(bubbleText(_liveBubble)); };
      b.appendChild(btn);
    }
    scrollToBottomIfSticky();
    preemptTts(delta);
  } else {
    _liveText = delta;
    addAssistant(delta, {live:true});
    // Grab the bubble we just created
    _liveBubble = chat.lastElementChild;
  }
}
function resetLiveBubble() { _liveBubble = null; _liveText = ""; }
function addAssistant(text, opts){
  // Contract-check wrap-ups arrive as role=assistant with source=contract_check.
  // Route them to the distinct banner so they don't look like real assistant turns.
  if (opts && opts.source === "contract_check") return addContractCheckBanner(text);
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
    const label=mk("div","msg-label q-label");label.textContent="Questions — pick options below";
    d.appendChild(label);
    const selections={};
    structured.forEach((q,qi)=>{
      const card=mk("div","q-card");
      if(q.header){const h=mk("div","msg-label q-header");h.textContent=q.header;card.appendChild(h);}
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
    const label=mk("div","msg-label q-label");label.textContent="Question — reply below";
    const body=mk("div","q-text");body.innerHTML=fmt(text);
    d.appendChild(label);d.appendChild(body);
  }
  chat.appendChild(d);
  scrollToBottomForce();
  if(window.innerWidth>768)inp.focus();
  inp.setAttribute("placeholder","Answer the question above...");
}

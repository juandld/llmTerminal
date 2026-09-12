// Voice-note recording UI for llmTerminal — classic script, shares global
// scope with app.js. Extracted (refactor 2026-06-10, app.js phase 9).

// ── Voice-note recovery via IndexedDB (2026-08-14 train-work hardening) ──
// Recorded blobs are persisted to IDB BEFORE upload starts so a tab-death,
// signal drop, or backgrounded browser can't lose the recording. On page
// load / connect we sweep for un-uploaded records for the current session
// and re-attempt upload automatically.
const VN_DB_NAME="llmt_voice"; const VN_STORE="recordings";

// Voice+text compose-attach state. When compose has text at record-start we
// show a chip letting the user know the text will ride along; tapping ×
// detaches so the voice sends solo and text stays in compose.
let voiceAttachDetached=false;

function _voiceAttachActiveText(){
  if(voiceAttachDetached) return "";
  const t=(inp&&(inp.dataset.prevValue||inp.value)||"").trim();
  return t;
}
function _renderVoiceAttachChip(container){
  if(!container) return;
  container.querySelectorAll(".voice-attach-chip").forEach(c=>c.remove());
  const text=_voiceAttachActiveText();
  if(!text) return;
  const chip=mk("div","voice-attach-chip");
  const truncated=text.length>60?text.slice(0,57)+"…":text;
  const icon=mk("span","vac-icon");icon.textContent="📎";
  const label=mk("span","vac-label");label.textContent="will send with: ";
  const txt=mk("span","vac-text");txt.textContent="“"+truncated+"”";
  const btn=mk("button","vac-detach");btn.type="button";btn.textContent="×";
  btn.title="Detach — send voice alone, keep text in compose";
  btn.onclick=(e)=>{
    e.stopPropagation();
    voiceAttachDetached=true;
    document.querySelectorAll(".voice-attach-chip").forEach(c=>c.remove());
    _refreshVoiceSendLabels();
  };
  chip.appendChild(icon);chip.appendChild(label);chip.appendChild(txt);chip.appendChild(btn);
  container.appendChild(chip);
}
function _refreshVoiceSendLabels(){
  const hasAttach=_voiceAttachActiveText().length>0;
  const mobileSend=document.querySelector("#voiceTimer .voice-send");
  if(mobileSend) mobileSend.textContent=hasAttach?"Send voice + text ↑":"Send ↑";
}
function _vnOpenDB(){
  return new Promise((resolve,reject)=>{
    if(!self.indexedDB){reject(new Error("no indexedDB"));return;}
    const req=indexedDB.open(VN_DB_NAME,1);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(VN_STORE)) db.createObjectStore(VN_STORE,{keyPath:"id"});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function vnPersist(rec){
  try{
    const db=await _vnOpenDB();
    await new Promise((res,rej)=>{
      const tx=db.transaction(VN_STORE,"readwrite");
      tx.objectStore(VN_STORE).put(rec);
      tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
    });
    db.close();
  }catch(e){ console.warn("[vn-idb] persist failed:",e.message); }
}
async function vnDelete(id){
  if(!id) return;
  try{
    const db=await _vnOpenDB();
    await new Promise((res)=>{
      const tx=db.transaction(VN_STORE,"readwrite");
      tx.objectStore(VN_STORE).delete(id);
      tx.oncomplete=()=>res(); tx.onerror=()=>res();
    });
    db.close();
  }catch{}
}
async function vnListPending(){
  try{
    const db=await _vnOpenDB();
    const items=await new Promise((res,rej)=>{
      const tx=db.transaction(VN_STORE,"readonly");
      const req=tx.objectStore(VN_STORE).getAll();
      req.onsuccess=()=>res(req.result||[]);
      req.onerror=()=>rej(req.error);
    });
    db.close();
    return items;
  }catch{ return []; }
}
// Sweep on session-open: re-upload any recordings still pending for THIS
// session. Cross-session recordings are left alone until you switch to that
// chat; abandoned ones (>7 days) are garbage-collected.
async function vnSweepPendingForCurrentSession(){
  const currentSid=(session&&session.id)||null;
  if(!currentSid) return;
  const items=await vnListPending();
  for(const rec of items){
    if(rec.sessionId!==currentSid){
      if(Date.now()-(rec.createdAt||0) > 7*86400000) vnDelete(rec.id);
      continue;
    }
    // Skip if the local bubble is already in the DOM (double-sweep guard).
    if(rec.id && chat.querySelector('.msg.user.voice-note-msg[data-vn-id="'+CSS.escape(rec.id)+'"]')) continue;
    const duration=rec.duration||0;
    const msgEl=addVoiceNoteUser(rec.blob,duration,[]);
    msgEl.dataset.vnId=rec.id;
    msgEl.dataset.recovered="1";
    const vn=msgEl.querySelector(".vn-bubble");
    if(vn){
      const banner=mk("div","vn-recovered");
      banner.textContent="↺ Recovered from previous session — re-uploading";
      vn.prepend(banner);
    }
    attemptVoiceUpload(rec.blob,msgEl,[],0,rec.id,rec.vnText||"");
  }
}

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
  // Hide the "next chat needing attention" fab — it sits at z:200 above the
  // recording overlay's z:100 and steals taps meant for the × detach chip / Send.
  const fab=document.getElementById("fab");
  if(fab){fab.dataset.prevDisplay=fab.style.display||"";fab.style.display="none";}
  // Fresh recording — text-attach starts un-detached.
  voiceAttachDetached=false;
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
    // Desktop attach chip: sibling ABOVE the recording strip, inside .input-bar
    let dc=document.getElementById("voiceAttachChipDesktop");
    if(!dc){dc=mk("div","voice-attach-chip-host");dc.id="voiceAttachChipDesktop";const bar=document.querySelector(".input-bar");bar.insertBefore(dc,ri);}
    dc.style.display="";
    _renderVoiceAttachChip(dc);
  } else {
    if(inp){inp.value="";inp.readOnly=true;inp.placeholder="⏺ Recording...";if(typeof _updateClearBtn==="function")_updateClearBtn();}
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
      const chipHost=mk("div","voice-attach-chip-host");chipHost.id="voiceAttachChipMobile";
      timer.appendChild(info);timer.appendChild(chipHost);timer.appendChild(actions);
      document.body.appendChild(timer);
    }
    timer.style.display="flex";
    const mobileChipHost=document.getElementById("voiceAttachChipMobile");
    if(mobileChipHost){mobileChipHost.style.display="";_renderVoiceAttachChip(mobileChipHost);}
    _refreshVoiceSendLabels();
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
  if(inp){inp.style.display="";inp.readOnly=false;inp.value=inp.dataset.prevValue||"";inp.placeholder="Message Claude...";if(typeof _updateClearBtn==="function")_updateClearBtn();}
  const ri=document.getElementById("voiceInline");
  if(ri)ri.style.display="none";
  const timer=document.getElementById("voiceTimer");
  if(timer)timer.style.display="none";
  // Tear down attach chips — sendVoiceNote() has already captured the text
  // (it reads inp.value/prevValue at send time before this frame's clear).
  document.querySelectorAll(".voice-attach-chip-host").forEach(h=>{h.style.display="none";h.querySelectorAll(".voice-attach-chip").forEach(c=>c.remove());});
  // Restore attention-nav fab that startVoiceUI hid.
  const fab=document.getElementById("fab");
  if(fab && fab.dataset.prevDisplay!==undefined){fab.style.display=fab.dataset.prevDisplay;delete fab.dataset.prevDisplay;}
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
  // Capture compose text riding along, unless user tapped × on the chip to detach.
  // endVoiceUI() has already restored inp.value from prevValue by now.
  const vnText=voiceAttachDetached?"":((inp&&inp.value)||"").trim();
  voiceAttachDetached=false;
  // If we're attaching text, clear it from compose immediately so it can't be
  // sent twice by a rapid follow-up tap on Send.
  if(vnText && inp){ inp.value=""; inp.style.height="44px"; localStorage.removeItem("llmt_draft"); if(typeof _updateClearBtn==="function")_updateClearBtn(); }
  const msgEl=addVoiceNoteUser(blob,duration,vnPreviews);
  if(vnImages.length) clearImages();
  // Voice note is an engagement signal — promote the chat out of done/archived
  // immediately so the recording device sees it move in the sidebar without
  // waiting for the 15s poll.
  promoteCurrentSessionToActive();
  // Persist the blob to IDB BEFORE upload so a tab-death mid-upload doesn't
  // vaporize the recording. Cleared inside attemptVoiceUpload on success.
  const recId=(self.crypto&&crypto.randomUUID)?crypto.randomUUID():("vn_"+Date.now()+"_"+Math.random().toString(36).slice(2,8));
  msgEl.dataset.vnId=recId;
  await vnPersist({
    id: recId,
    sessionId: (session&&session.id)||null,
    project: (session&&session.project)||null,
    blob,
    mimeType: blob.type||"audio/mp4",
    duration,
    vnText,
    createdAt: Date.now(),
  });
  attemptVoiceUpload(blob, msgEl, vnImages, 0, recId, vnText);
}

// Wait until we have a valid nonce on an open WS, or timeout.
// Resolves true if a fresh nonce is available, false on timeout.
function waitForFreshVoiceNonce(timeoutMs){
  return new Promise(resolve=>{
    if(currentVoiceNonce && ws && ws.readyState===1) return resolve(true);
    const start=Date.now();
    const iv=setInterval(()=>{
      if(currentVoiceNonce && ws && ws.readyState===1){
        clearInterval(iv); resolve(true);
      } else if(Date.now()-start>timeoutMs){
        clearInterval(iv); resolve(false);
      }
    },200);
  });
}

async function attemptVoiceUpload(blob, msgEl, vnImages, attempts, recId, vnText){
  attempts = attempts || 0;
  vnText = vnText || "";
  const MAX_AUTO_RETRIES = 1;
  const statusEl=msgEl.querySelector(".vn-status");
  const setVnStatus=(txt,cls)=>{
    if(statusEl){statusEl.style.display="";statusEl.textContent=txt;statusEl.className="vn-status"+(cls?" "+cls:"");}
  };
  try{
    // If WS is dead or we have no nonce, wait briefly for the reconnect to
    // reissue one. Sending with a known-stale nonce guarantees a 401.
    if(!currentVoiceNonce || !ws || ws.readyState!==1){
      setVnStatus("Waiting for connection…","vn-s-active");
      await waitForFreshVoiceNonce(15000);
    }
    setVnStatus("Uploading…","vn-s-active");
    const sid=(session&&session.id)||"";
    // Prefer the WS-bound nonce — it proves this upload is from the currently-open
    // socket. Falls back to bare session= only if nonce hasn't arrived yet (server
    // logs that path as deprecated).
    // noQueue=1 when images OR compose text are attached: we want ONE message
    // (the WS prompt below, which carries transcript + images + text), not
    // two (server-queued transcript + client-WS composite prompt) firing as
    // separate Claude turns.
    let qs = currentVoiceNonce
      ? "?nonce="+encodeURIComponent(currentVoiceNonce)
      : (sid?"?session="+encodeURIComponent(sid):"");
    if(vnImages.length || vnText){ qs += (qs?"&":"?") + "noQueue=1"; }
    // Track upload progress via XMLHttpRequest for real upload %
    const data=await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open("POST","./voice-note"+qs);
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
        if(xhr.status>=400){
          let body=null;
          try{ body=JSON.parse(xhr.responseText); }catch{}
          const err=new Error("upload failed: "+xhr.status);
          err.status=xhr.status;
          err.staleNonce=!!(body&&body.stale_nonce);
          err.ghostSession=!!(body&&body.ghost_session_id);
          err.serverMessage=(body&&body.error)||null;
          return reject(err);
        }
        try{resolve(JSON.parse(xhr.responseText))}catch(e){reject(e)}
      };
      xhr.onerror=()=>{const e=new Error("network error");e.network=true;reject(e);};
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
    // Server already queued the transcript — only send from client if images OR
    // compose text attached. When either is present we passed noQueue=1 above, so
    // server did NOT queue. Send composite (attached text + transcript + images) as
    // ONE WS prompt, tagged with voice-note metadata so it persists as a proper
    // voice-note bubble on reload.
    if(data.transcript && (vnImages.length || vnText)){
      const combinedText = vnText
        ? (vnText + "\n\n" + data.transcript)
        : data.transcript;
      const clientId=genMsgId();
      // Tag the local bubble with this client_id so a server-side queue_state
      // (busy session → queueAppend with client_id) finds it via data-client-id
      // and just marks it queued instead of rendering a second voice-note bubble.
      msgEl.dataset.clientId=clientId;
      outbox.push({id:clientId,text:combinedText,images:vnImages,ts:Date.now(),sid:(session&&session.id)||localStorage.getItem("llmt_session")||null});saveOutbox();
      if(ws&&ws.readyState===1){
        ws.send(JSON.stringify({type:"prompt",client_id:clientId,text:combinedText,images:vnImages,source:"voice-note",audioUrl:data.audioUrl}));
        setBusy(true);
      }
    }
    // Success: clear any retry handler left by a prior failed attempt.
    msgEl.onclick=null;
    // Server has it — drop the IDB copy. Failed uploads keep the IDB entry so
    // the next page-load sweep can retry it.
    if(recId) vnDelete(recId);
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
    // Auto-retry on stale/ghost nonce, once.
    // Root cause: WS died server-side (heartbeat timeout) but the client didn't
    // notice yet, so the local currentVoiceNonce is stale. Force a reconnect to
    // reissue the nonce, then retry.
    if((err.staleNonce||err.ghostSession) && attempts<MAX_AUTO_RETRIES){
      console.warn("[voice-note] stale nonce/ghost session — forcing WS reconnect and retrying");
      currentVoiceNonce=null;
      try{ if(ws&&ws.readyState===1) ws.close(); }catch{}
      setVnStatus("Reconnecting…","vn-s-active");
      return attemptVoiceUpload(blob, msgEl, vnImages, attempts+1, recId, vnText);
    }
    console.error("[voice-note] upload failed:",err);
    const label = (err.staleNonce||err.ghostSession)
      ? "⚠ Connection lost — tap to retry"
      : "⚠ Upload failed — tap to retry";
    setVnStatus(label,"vn-s-error");
    // Tap to retry — reuse the SAME bubble (don't call sendVoiceNote which
    // would create a duplicate bubble via addVoiceNoteUser).
    msgEl.onclick=()=>{msgEl.onclick=null;attemptVoiceUpload(blob, msgEl, vnImages, 0, recId, vnText);};
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

// Voice-note recording UI for llmTerminal — classic script, shares global
// scope with app.js. Extracted (refactor 2026-06-10, app.js phase 9).

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
  } else {
    if(inp){inp.value="";inp.readOnly=true;inp.placeholder="⏺ Recording...";}
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
      timer.appendChild(info);timer.appendChild(actions);
      document.body.appendChild(timer);
    }
    timer.style.display="flex";
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
  if(inp){inp.style.display="";inp.readOnly=false;inp.value=inp.dataset.prevValue||"";inp.placeholder="Message Claude...";}
  const ri=document.getElementById("voiceInline");
  if(ri)ri.style.display="none";
  const timer=document.getElementById("voiceTimer");
  if(timer)timer.style.display="none";
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
  const msgEl=addVoiceNoteUser(blob,duration,vnPreviews);
  if(vnImages.length) clearImages();
  const statusEl=msgEl.querySelector(".vn-status");
  const setVnStatus=(txt,cls)=>{
    if(statusEl){statusEl.textContent=txt;statusEl.className="vn-status"+(cls?" "+cls:"");}
  };
  try{
    setVnStatus("Uploading…","vn-s-active");
    const sid=(session&&session.id)||"";
    // Prefer the WS-bound nonce — it proves this upload is from the currently-open
    // socket. Falls back to bare session= only if nonce hasn't arrived yet (server
    // logs that path as deprecated).
    const qs = currentVoiceNonce
      ? "?nonce="+encodeURIComponent(currentVoiceNonce)
      : (sid?"?session="+encodeURIComponent(sid):"");
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
        if(xhr.status>=400) return reject(new Error("upload failed: "+xhr.status));
        try{resolve(JSON.parse(xhr.responseText))}catch(e){reject(e)}
      };
      xhr.onerror=()=>reject(new Error("network error"));
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
    // Server already queued the transcript — only send from client if images attached
    if(data.transcript&&vnImages.length){
      const clientId=genMsgId();
      outbox.push({id:clientId,text:data.transcript,images:vnImages,ts:Date.now()});saveOutbox();
      if(ws&&ws.readyState===1){
        ws.send(JSON.stringify({type:"prompt",client_id:clientId,text:data.transcript,images:vnImages}));
        setBusy(true);
      }
    }
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
    console.error("[voice-note] upload failed:",err);
    setVnStatus("⚠ Upload failed — tap to retry","vn-s-error");
    // Tap to retry
    msgEl.onclick=()=>{msgEl.onclick=null;sendVoiceNote(blob);};
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

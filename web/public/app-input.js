// Message input: clear/send/image attachments — classic script, shares global scope with app.js.
// Extracted (refactor 2026-06-10).

function _clearInput(){
  inp.value=""; inp.style.height="44px"; localStorage.removeItem("llmt_draft"); clearImages();
  if(typeof _updateClearBtn==="function") _updateClearBtn();
}

// ── Phone wake / tab resume: force-reconnect so chat is always fresh ──
document.addEventListener("visibilitychange",()=>{
  if(document.hidden) return;
  // Page just became visible (phone unlocked, tab refocused)
  if(!session) return;
  const wsAlive = ws && ws.readyState===WebSocket.OPEN;
  // Server pings every 20s; 30s covers one skipped/late ping without a false reconnect.
  const stale = Date.now()-lastServerMsgTs > 30000;
  if(!wsAlive || stale){
    const sid=session.id, proj=session.project; // capture before any async weirdness
    console.log("[visibility] page visible, reconnecting (wsAlive="+wsAlive+", stale="+stale+", session="+sid+")");
    // Don't pre-emptively wipe chat.innerHTML: the incoming `history` event will
    // wipe-and-re-render if it sees existing content. Wiping here causes a
    // visible blank-chat flash during every reconnect — matching David's
    // "the chat is inactive, refresh, and the answer was there" report.
    connect(proj,sid); // connect() already cleans up old ws
    return; // connect() will refreshPreviews on `ready`
  }
  // WS is technically open + recent, but mobile Safari may have queued/throttled
  // events while the tab was hidden — most-felt symptom: the file drawer goes
  // stale because the "done" event from a completed mid-background run never
  // ran its handler. Fetch drawer fresh on every visibility-visible so files
  // generated while away still appear.
  try { refreshPreviews(false); } catch {}
});

function send(){
  const rawText=inp.value.trim();
  // Prepend attached-file context if user has checkmarks in the drawer.
  // After send, the selection clears (next message starts fresh).
  const preamble = _attachedFilesPreamble();
  const text = preamble ? (preamble + (rawText || "(no message — attached files for context)")) : rawText;
  if(!text&&pendingImages.length===0) return;
  if (preamble) { selectedPreviewIds.clear(); _saveSelection(); renderDrawer(); renderSelectedTray(); }
  // Engaging an archived/done chat bumps it back to the active list immediately
  // — covers the queued, no-WS and live-send branches below in one place.
  promoteCurrentSessionToActive();
  // Request notification permission on first send (idempotent if already decided)
  requestNotifPermission();
  // Push to input history (for ArrowUp recall)
  pushInputHistory(text);
  historyIdx=-1;
  currentDraft="";
  // If busy, queue the message
  if(busy){
    const images=pendingImages.map(i=>({data:i.data,mimeType:i.mimeType}));
    const previews=pendingImages.map(i=>i.preview);
    const queuedId=genMsgId();
    // Tag with the session id so the drain in setBusy(false) can refuse to fire
    // it into a different chat if the user switches away (2026-07-03 bug).
    messageQueue.push({text,images,previews,clientId:queuedId,sessionId:session?.id||null});
    addQueued(text,previews,queuedId);
    _clearInput();
    renderQueueCount();
    return;
  }
  const prompt=text||"Describe the attached image(s).";
  const images=pendingImages.map(i=>({data:i.data,mimeType:i.mimeType}));
  const previews=pendingImages.map(i=>i.preview);

  // sid: bind the message to the chat it was typed in, so a reconnect on a
  // DIFFERENT chat can never flush it there (2026-07-07 lost-messages incident).
  const _sid=(session&&session.id)||localStorage.getItem("llmt_session")||null;
  if(!ws||ws.readyState!==1){
    const clientId=genMsgId();
    outbox.push({id:clientId,text,images,ts:Date.now(),sid:_sid});saveOutbox();
    // Reconnect — outbox will be flushed when "ready" arrives (no ws.onopen overwrite,
    // which would race the flush and double-send the prompt)
    connect(session?.project||_defaultProject(),session?.id);
    addUser(text,previews,clientId); _clearInput();
    setBusy(true);
    return;
  }
  const clientId=genMsgId();
  outbox.push({id:clientId,text,images,ts:Date.now(),sid:_sid});saveOutbox();
  ws.send(JSON.stringify({type:"prompt",client_id:clientId,text:prompt,images}));
  addUser(text,previews,clientId);
  // Tag live-rendered message so history replay doesn't duplicate
  const liveTs=Date.now();
  const last=chat.lastElementChild;
  if(last){last.dataset.ts=liveTs; lastRenderedTs=liveTs}
  _clearInput(); inp.setAttribute("placeholder","Message Claude...");
  localStorage.removeItem("llmt_draft_sel");
  setBusy(true);
}

// ── Image handling ──
// Anthropic's many-image rule rejects conversations where ANY image exceeds
// 2000px on a side once you accumulate several images. We downscale here so
// one phone screenshot can't poison a long session.
const MAX_IMAGE_DIM = 2000;
function _pushImageRaw(file){
  const reader=new FileReader();
  reader.onload=()=>{
    const dataUrl=reader.result;
    const base64=dataUrl.split(",")[1];
    const mimeType=file.type||"image/png";
    pendingImages.push({data:base64,mimeType,preview:dataUrl});
    renderImagePreviews();
  };
  reader.readAsDataURL(file);
}
async function addImage(file){
  try {
    const bitmap=await createImageBitmap(file);
    const maxSide=Math.max(bitmap.width,bitmap.height);
    if(maxSide<=MAX_IMAGE_DIM){
      if(bitmap.close)bitmap.close();
      _pushImageRaw(file);
      return;
    }
    const scale=MAX_IMAGE_DIM/maxSide;
    const w=Math.round(bitmap.width*scale);
    const h=Math.round(bitmap.height*scale);
    const canvas=document.createElement("canvas");
    canvas.width=w;canvas.height=h;
    canvas.getContext("2d").drawImage(bitmap,0,0,w,h);
    if(bitmap.close)bitmap.close();
    const outMime="image/jpeg";
    const dataUrl=canvas.toDataURL(outMime,0.92);
    const base64=dataUrl.split(",")[1];
    pendingImages.push({data:base64,mimeType:outMime,preview:dataUrl});
    renderImagePreviews();
  } catch(err){
    console.error("addImage downscale failed, sending original:",err);
    _pushImageRaw(file);
  }
}
function handleImgFiles(e){
  const files=e.target.files||[];
  for(const f of files){
    if(f.type.startsWith("image/")) addImage(f);
    else uploadArbitraryFile(f);
  }
  e.target.value="";
}
// Route: images go into the inline compose bar (existing addImage path).
// Everything else — audio call recordings, PDFs, docs, archives — POSTs
// immediately to /upload, becoming its own queued user message that the
// agent handles on the next drain.
function uploadArbitraryFile(file){
  const nonce=currentVoiceNonce;
  const sid=(session&&session.id)||"";
  if(!nonce && !sid){ showUploadToast("Can't upload — no active chat","err"); return; }
  const qs=(nonce?"?nonce="+encodeURIComponent(nonce):"?session="+encodeURIComponent(sid))
    + "&filename="+encodeURIComponent(file.name||"upload.bin");
  const sizeStr=file.size>1048576?(file.size/1048576).toFixed(1)+" MB":Math.round(file.size/1024)+" KB";
  const toast=showUploadToast("Uploading "+file.name+" ("+sizeStr+")…","active");
  const xhr=new XMLHttpRequest();
  xhr.open("POST","./upload"+qs);
  xhr.setRequestHeader("Content-Type",file.type||"application/octet-stream");
  xhr.upload.onprogress=(e)=>{
    if(e.lengthComputable){
      const pct=Math.round(e.loaded/e.total*100);
      updateUploadToast(toast,"Uploading "+file.name+" — "+pct+"%","active");
      if(pct>=100) updateUploadToast(toast,"Processing "+file.name+"…","active");
    }
  };
  xhr.upload.onload=()=>updateUploadToast(toast,"Processing "+file.name+"…","active");
  xhr.onload=()=>{
    if(xhr.status>=400){
      let msg="Upload failed ("+xhr.status+")";
      try{const j=JSON.parse(xhr.responseText);if(j.error)msg="Upload failed: "+j.error;}catch{}
      updateUploadToast(toast,msg,"err",3500);
      return;
    }
    let j={}; try{j=JSON.parse(xhr.responseText)}catch{}
    const doneMsg=j.transcript?("Transcribed "+file.name):("Uploaded "+file.name);
    updateUploadToast(toast,doneMsg+(j.transcriptError?" ("+j.transcriptError+")":""),"ok",2200);
    // Session cost / queue state broadcast will render the actual bubble; no
    // client-side placeholder needed.
  };
  xhr.onerror=()=>updateUploadToast(toast,"Upload failed — network error","err",3500);
  xhr.send(file);
}
// Lightweight top-of-viewport toast for upload progress. One stacked column.
function showUploadToast(text,cls){
  let host=document.getElementById("uploadToastHost");
  if(!host){
    host=document.createElement("div");
    host.id="uploadToastHost";
    host.className="upload-toast-host";
    document.body.appendChild(host);
  }
  const el=document.createElement("div");
  el.className="upload-toast"+(cls?" ut-"+cls:"");
  el.textContent=text;
  host.appendChild(el);
  return el;
}
function updateUploadToast(el,text,cls,autoDismissMs){
  if(!el) return;
  el.className="upload-toast"+(cls?" ut-"+cls:"");
  el.textContent=text;
  if(autoDismissMs){
    setTimeout(()=>{ el.classList.add("ut-fade"); setTimeout(()=>el.remove(),300); }, autoDismissMs);
  }
}
function clearImages(){pendingImages=[];renderImagePreviews()}
function removeImage(i){pendingImages.splice(i,1);renderImagePreviews()}
function renderImagePreviews(){
  const bar=document.getElementById("imgBar");
  bar.innerHTML="";
  pendingImages.forEach((img,i)=>{
    const d=document.createElement("div");d.className="img-preview";
    d.innerHTML='<img src="'+img.preview+'"><button class="x" onclick="removeImage('+i+')">&times;</button>';
    bar.appendChild(d);
  });
}

// Paste handler — images inline, other files uploaded to the chat.
document.addEventListener("paste",(e)=>{
  const items=e.clipboardData?.items;
  if(!items)return;
  let handled=false;
  for(const item of items){
    if(item.kind!=="file") continue;
    const f=item.getAsFile();
    if(!f) continue;
    handled=true;
    if(item.type.startsWith("image/")) addImage(f);
    else uploadArbitraryFile(f);
  }
  if(handled) e.preventDefault();
});
// Drop handler — same routing.
chat.addEventListener("dragover",(e)=>{e.preventDefault()});
chat.addEventListener("drop",(e)=>{
  e.preventDefault();
  for(const file of (e.dataTransfer?.files||[])){
    if(file.type.startsWith("image/")) addImage(file);
    else uploadArbitraryFile(file);
  }
});

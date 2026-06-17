// Message input: clear/send/image attachments — classic script, shares global scope with app.js.
// Extracted (refactor 2026-06-10).

function _clearInput(){
  inp.value=""; inp.style.height="44px"; localStorage.removeItem("llmt_draft"); clearImages();
}

// ── Phone wake / tab resume: force-reconnect so chat is always fresh ──
document.addEventListener("visibilitychange",()=>{
  if(document.hidden) return;
  // Page just became visible (phone unlocked, tab refocused)
  if(!session) return;
  const wsAlive = ws && ws.readyState===WebSocket.OPEN;
  const stale = Date.now()-lastServerMsgTs > 10000; // >10s since last server msg
  if(!wsAlive || stale){
    const sid=session.id, proj=session.project; // capture before any async weirdness
    console.log("[visibility] page visible, reconnecting (wsAlive="+wsAlive+", stale="+stale+", session="+sid+")");
    chat.innerHTML=""; lastRenderedTs=0;
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
    messageQueue.push({text,images,previews,clientId:queuedId});
    addQueued(text,previews,queuedId);
    _clearInput();
    renderQueueCount();
    return;
  }
  const prompt=text||"Describe the attached image(s).";
  const images=pendingImages.map(i=>({data:i.data,mimeType:i.mimeType}));
  const previews=pendingImages.map(i=>i.preview);

  if(!ws||ws.readyState!==1){
    const clientId=genMsgId();
    outbox.push({id:clientId,text,images,ts:Date.now()});saveOutbox();
    // Reconnect — outbox will be flushed when "ready" arrives (no ws.onopen overwrite,
    // which would race the flush and double-send the prompt)
    connect(session?.project||_defaultProject(),session?.id);
    addUser(text,previews,clientId); _clearInput();
    setBusy(true);
    return;
  }
  const clientId=genMsgId();
  outbox.push({id:clientId,text,images,ts:Date.now()});saveOutbox();
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
  }
  e.target.value="";
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

// Paste handler
document.addEventListener("paste",(e)=>{
  const items=e.clipboardData?.items;
  if(!items)return;
  for(const item of items){
    if(item.type.startsWith("image/")){
      e.preventDefault();
      addImage(item.getAsFile());
    }
  }
});
// Drop handler
chat.addEventListener("dragover",(e)=>{e.preventDefault()});
chat.addEventListener("drop",(e)=>{
  e.preventDefault();
  for(const file of (e.dataTransfer?.files||[])){
    if(file.type.startsWith("image/")) addImage(file);
  }
});

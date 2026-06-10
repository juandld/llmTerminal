// Files drawer: file listing, selection, audio playback, previews, modal,
// search/filter, audio-review. Classic script, shares global scope with app.js.
// Extracted (refactor 2026-06-10, app.js phase 7).

function fileKindMeta(p) {
  const t = p && p.type;
  if (t === "email")    return { kind: "email",    icon: "✉",  label: "Email"    };
  if (t === "document") return { kind: "document", icon: "📄", label: "Doc"      };
  if (t === "voice")    return { kind: "voice",    icon: "🎙", label: "Voice"    };
  const path = (p?.content?.body_text || "").replace(/^FILE_PATH:/, "");
  const name = (path || p?.title || "").toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || "";
  if (/^(mp3|m4a|wav|ogg|opus|aac|flac)$/.test(ext))       return { kind: "audio", icon: "🎵", label: "Audio" };
  if (/^(mp4|mov)$/.test(ext))                              return { kind: "video", icon: "🎬", label: "Video" };
  if (ext === "webm") return { kind: "audio", icon: "🎵", label: "Audio" }; // webm here is almost always voice/audio
  if (/^(png|jpg|jpeg|gif|svg|webp)$/.test(ext))            return { kind: "image", icon: "🖼", label: "Image" };
  if (ext === "pdf")                                         return { kind: "pdf",   icon: "📕", label: "PDF"   };
  if (/^(md|txt)$/.test(ext))                                return { kind: "text",  icon: "📝", label: "Text"  };
  if (/^(json|yaml|yml|csv|toml|xml)$/.test(ext))            return { kind: "data",  icon: "📊", label: "Data"  };
  if (/^(py|js|ts|tsx|jsx|svelte|sh|rb|go|rs)$/.test(ext))   return { kind: "code",  icon: "⚡", label: "Code"  };
  if (/^(html|htm)$/.test(ext))                              return { kind: "web",   icon: "🌐", label: "Web"   };
  return { kind: "other", icon: "📎", label: "File" };
}

function setSortMode(m) {
  if (!["newest","oldest","name","type"].includes(m)) return;
  sortMode = m;
  try { localStorage.setItem("llmt_file_sort", m); } catch {}
  const sel = document.getElementById("drawerSortSel");
  if (sel) sel.value = m;
  renderDrawer();
}
// Files the user has check-marked in the drawer to attach to the next message.
let selectedPreviewIds = (function(){
  try { return new Set(JSON.parse(localStorage.getItem("llmt_selected_previews")||"[]")); } catch { return new Set(); }
})();
let _lastSelectedId = null;          // anchor for shift-click range select
let _currentDrawerOrder = [];        // ids in the order currently rendered (for range)
function _saveSelection(){ try{ localStorage.setItem("llmt_selected_previews", JSON.stringify([...selectedPreviewIds])); }catch{} }
function toggleFileSelection(id, ev){
  ev = ev || window.event;
  const isShift = ev && ev.shiftKey;
  if (isShift && _lastSelectedId && _lastSelectedId !== id && _currentDrawerOrder.length) {
    const i1 = _currentDrawerOrder.indexOf(_lastSelectedId);
    const i2 = _currentDrawerOrder.indexOf(id);
    if (i1 >= 0 && i2 >= 0) {
      const a = Math.min(i1, i2), b = Math.max(i1, i2);
      // Windows-style range select: every row in [anchor..current] becomes selected,
      // unconditionally. The anchor (_lastSelectedId) does NOT move so subsequent
      // shift-clicks extend from the same starting point.
      for (let i = a; i <= b; i++) selectedPreviewIds.add(_currentDrawerOrder[i]);
      _saveSelection();
      renderDrawer();
      renderSelectedTray();
      return;
    }
  }
  // Plain click — toggle this row and move the anchor to it.
  if (selectedPreviewIds.has(id)) selectedPreviewIds.delete(id);
  else selectedPreviewIds.add(id);
  _lastSelectedId = id;
  _saveSelection();
  renderDrawer();
  renderSelectedTray();
}

// ---- Sequential audio playback for selected files ----
let _playbackQueue = [];
let _playbackIndex = -1;
let _playbackEl = null;

function _selectedAudioQueue(){
  // Iterate selectedPreviewIds (NOT _currentDrawerOrder) so files hidden by the
  // active filter still play. The drawer order is used only for sorting.
  const items = [];
  for (const id of selectedPreviewIds) {
    const p = sessionPreviews.find(x => x.id === id);
    if (!p) continue;
    const meta = fileKindMeta(p);
    if (meta.kind !== "audio" && meta.kind !== "voice") continue;
    const bt = (p.content?.body_text) || "";
    if (!bt.startsWith("FILE_PATH:")) continue;
    const fp = bt.slice("FILE_PATH:".length);
    items.push({ id, url: apiUrl("/api/file?path=" + encodeURIComponent(fp)), title: p.title || fp.split("/").pop() });
  }
  // Sort by current drawer order when possible (so playback follows the sort
  // mode the user sees), unattributed entries trail at the end.
  const orderIdx = new Map(_currentDrawerOrder.map((id, i) => [id, i]));
  items.sort((a, b) => {
    const ia = orderIdx.has(a.id) ? orderIdx.get(a.id) : Number.MAX_SAFE_INTEGER;
    const ib = orderIdx.has(b.id) ? orderIdx.get(b.id) : Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
  return items;
}

function playSelectedAudio(){
  const q = _selectedAudioQueue();
  if (!q.length) return;
  _playbackQueue = q;
  _playbackIndex = 0;
  _playCurrent();
}

function _playCurrent(){
  if (_playbackIndex < 0 || _playbackIndex >= _playbackQueue.length) { stopPlayback(); return; }
  const cur = _playbackQueue[_playbackIndex];
  console.log("[playback] track", _playbackIndex + 1, "/", _playbackQueue.length, "→", cur.title);
  // Tear down the previous element FIRST and null out all listeners, so the
  // cleanup itself (removeAttribute src + load()) can't fire an error event
  // that re-enters our skip-on-error handler and double-advances the index.
  if (_playbackEl) {
    try {
      _playbackEl.onended = null;
      _playbackEl.onerror = null;
      _playbackEl.onplay  = null;
      _playbackEl.onpause = null;
      _playbackEl.pause();
      _playbackEl.removeAttribute("src");
      _playbackEl.load();
    } catch {}
  }
  _playbackEl = new Audio();
  _playbackEl.onended = () => { _playbackIndex++; _playCurrent(); };
  _playbackEl.onerror = (e) => {
    console.warn("[playback] error on", cur.url, e);
    _playbackIndex++;
    _playCurrent();
  };
  _playbackEl.onplay  = () => renderSelectedTray();
  _playbackEl.onpause = () => renderSelectedTray();
  _playbackEl.src = cur.url;
  _playbackEl.load();
  const playPromise = _playbackEl.play();
  if (playPromise && playPromise.catch) {
    playPromise.catch(err => console.warn("[playback] play() rejected:", err && err.message || err));
  }
  renderSelectedTray();
}

function stopPlayback(){
  if (_playbackEl) {
    try {
      _playbackEl.onended = null;
      _playbackEl.onerror = null;
      _playbackEl.onplay  = null;
      _playbackEl.onpause = null;
      _playbackEl.pause();
      _playbackEl.removeAttribute("src");
      _playbackEl.load();
    } catch {}
    _playbackEl = null;
  }
  _playbackQueue = [];
  _playbackIndex = -1;
  renderSelectedTray();
}

function skipPrev(){ if (_playbackIndex > 0) { _playbackIndex--; _playCurrent(); } }
function skipNext(){ _playbackIndex++; _playCurrent(); }
function pauseToggle(){
  if (!_playbackEl) return;
  if (_playbackEl.paused) _playbackEl.play().catch(()=>{}); else _playbackEl.pause();
  renderSelectedTray();
}
function clearFileSelection(){ selectedPreviewIds.clear(); _saveSelection(); renderDrawer(); renderSelectedTray(); }
function _selectedPreviewPaths(){
  // Map selected ids back to absolute paths (FILE_PATH-type only) or fall back to title.
  const out = [];
  for (const id of selectedPreviewIds) {
    const p = sessionPreviews.find(x=>x.id===id);
    if (!p) continue;
    const bt = (p.content?.body_text) || "";
    if (bt.startsWith("FILE_PATH:")) out.push({ id, path: bt.slice("FILE_PATH:".length), title: p.title });
    else out.push({ id, path: null, title: p.title });
  }
  return out;
}
function _attachedFilesPreamble(){
  const sel = _selectedPreviewPaths();
  if (!sel.length) return "";
  const lines = sel.map(s => "  - " + (s.path || s.title));
  return "Attached files (from drawer, treat as context for this message):\n" + lines.join("\n") + "\n\n";
}
let _trayExpanded = false;
function _toggleTrayExpand(){ _trayExpanded = !_trayExpanded; renderSelectedTray(); }

// Surgically highlight the currently-playing row in the file drawer. Avoids a
// full renderDrawer (which would reset scroll and feel jumpy).
function _updatePlayingHighlight(){
  const playingId = (_playbackIndex >= 0 && _playbackQueue.length) ? _playbackQueue[_playbackIndex]?.id : null;
  document.querySelectorAll('.fp-card.fp-playing').forEach(el => el.classList.remove('fp-playing'));
  if (playingId) {
    const el = document.querySelector('.fp-card[data-pid="' + (window.CSS && CSS.escape ? CSS.escape(playingId) : playingId.replace(/"/g, '\\"')) + '"]');
    if (el) el.classList.add('fp-playing');
  }
}

function renderSelectedTray(){
  let tray = document.getElementById("fpSelectedTray");
  const playingId = (_playbackIndex >= 0 && _playbackQueue.length) ? _playbackQueue[_playbackIndex]?.id : null;
  const playing = !!playingId;
  if (!selectedPreviewIds.size && !playing) { if (tray) tray.remove(); _updatePlayingHighlight(); return; }
  if (!tray) {
    tray = mk("div", "fp-selected-tray");
    tray.id = "fpSelectedTray";
    const bar = document.querySelector(".input-bar");
    if (bar && bar.parentNode) bar.parentNode.insertBefore(tray, bar);
  }
  const sel = _selectedPreviewPaths();
  const audioCount = _selectedAudioQueue().length;

  // Reorder so the currently-playing chip is first when collapsed — guarantees
  // it stays visible no matter how many other files are selected.
  let display = sel;
  if (playingId) {
    const idx = sel.findIndex(s => s.id === playingId);
    if (idx > 0) display = [sel[idx], ...sel.slice(0, idx), ...sel.slice(idx + 1)];
  }

  const MAX_CHIPS = 4;
  const overflow = display.length - MAX_CHIPS;
  const collapsed = !_trayExpanded && overflow > 0;
  const visible = collapsed ? display.slice(0, MAX_CHIPS) : display;

  // Header row: label + action buttons (always visible, doesn't wrap)
  let html = '<div class="fp-tray-head">';
  html +=   '<span class="fp-tray-label">📎 ' + sel.length + ' file' + (sel.length===1?'':'s') + '</span>';
  if (audioCount > 0 && !playing) {
    html += '<button class="fp-tray-play" onclick="playSelectedAudio()" title="Play selected audio (Enter)">▶ Play ' + audioCount + '</button>';
  }
  html +=   '<button class="fp-tray-clear" onclick="clearFileSelection()">clear</button>';
  html += '</div>';

  // Chip row (collapsible)
  html += '<div class="fp-tray-chips' + (collapsed ? '' : ' fp-tray-chips-expanded') + '">';
  for (const s of visible) {
    const isP = s.id === playingId;
    const name = (s.path ? s.path.split("/").pop() : s.title) || "";
    html += '<span class="fp-tray-chip' + (isP ? ' fp-chip-playing' : '') + '" title="' + esc(s.path||s.title) + '" onclick="' + (isP?'pauseToggle()':"playSingleFromId('"+s.id+"')") + '">'
         +    (isP ? '<span class="fp-chip-icon">▶</span>' : '')
         +    esc(name.slice(0, 32))
         +    ' <button class="fp-tray-x" onclick="event.stopPropagation();toggleFileSelection(\'' + s.id + '\')" aria-label="Remove">×</button>'
         +  '</span>';
  }
  if (collapsed) {
    html += '<button class="fp-tray-more" onclick="_toggleTrayExpand()">+' + overflow + ' more</button>';
  } else if (overflow > 0) {
    html += '<button class="fp-tray-more" onclick="_toggleTrayExpand()">show less</button>';
  }
  html += '</div>';

  // Now-playing strip (only when playing)
  if (playing) {
    const cur = _playbackQueue[_playbackIndex];
    const isPaused = _playbackEl && _playbackEl.paused;
    html += '<div class="fp-now-playing">'
         +    '<span class="fp-np-label">'+(isPaused?"⏸":"▶")+' '+(_playbackIndex+1)+'/'+_playbackQueue.length+' · '+esc((cur?.title||"").slice(0, 40))+'</span>'
         +    '<button class="fp-np-btn" onclick="skipPrev()" title="Previous" aria-label="Previous">⏮</button>'
         +    '<button class="fp-np-btn" onclick="pauseToggle()" title="Play/Pause" aria-label="Play/Pause">'+(isPaused?"▶":"⏸")+'</button>'
         +    '<button class="fp-np-btn" onclick="skipNext()" title="Next" aria-label="Next">⏭</button>'
         +    '<button class="fp-np-btn" onclick="stopPlayback()" title="Stop" aria-label="Stop">✕</button>'
         +  '</div>';
  }
  tray.innerHTML = html;
  _updatePlayingHighlight();
}

// Jump playback to a specific selected file (clicked from a tray chip).
function playSingleFromId(id) {
  const q = _selectedAudioQueue();
  const idx = q.findIndex(item => item.id === id);
  if (idx < 0) return;
  _playbackQueue = q;
  _playbackIndex = idx;
  _playCurrent();
}
let fileScope=(function(){try{return localStorage.getItem("llmt_file_scope")||"chat"}catch{return "chat"}})(); // chat | project

async function refreshPreviews(showNewInline){
  if(!session) return;
  try{
    const scopeQs = (fileScope === "project" && session.project)
      ? "project=" + encodeURIComponent(session.project)
      : "session_id=" + encodeURIComponent(session.id);
    // Fetch in parallel:
    //   /api/previews   = DB-backed: emails / documents / agent-set labels for files
    //   /api/drawer-files = filesystem-derived: actual file pins (reconciled at fetch time)
    // The drawer-files endpoint is the new source of truth for file rows; the DB endpoint
    // contributes label overrides + non-file previews (emails, structured drafts).
    const [dbRes, fsRes] = await Promise.all([
      fetch(apiUrl("/api/previews?" + scopeQs)).then(r => r.json()).catch(() => ({ previews: [] })),
      fetch(apiUrl("/api/drawer-files?" + scopeQs)).then(r => r.json()).catch(() => ({ files: [] })),
    ]);
    const dbPreviews = dbRes.previews || [];
    const fsFiles = fsRes.files || [];

    // Build a path -> dbPreview lookup so filesystem files can pick up agent-set labels
    const dbByPath = new Map();
    for (const p of dbPreviews) {
      const bt = p?.content?.body_text || "";
      if (bt.startsWith("FILE_PATH:")) dbByPath.set(bt.slice("FILE_PATH:".length).trim(), p);
    }

    // Materialize filesystem files into preview-shaped objects
    const fsPreviews = fsFiles.map(f => {
      const fromDb = dbByPath.get(f.path);
      // Voice notes are user-recorded audio prompts — they belong in the chat thread,
      // not in the default "Files" view. Tag them as type:"voice" so the drawer can
      // hide them unless the user explicitly toggles the Voice filter pill.
      const isVoice = f.kind === "voice";
      return {
        // Use the DB id if present (so attach-selection survives), else synthesize
        id: fromDb ? fromDb.id : ("fs:" + f.path),
        type: isVoice ? "voice" : "file",
        title: (fromDb && fromDb.title && fromDb.title !== "Untitled") ? fromDb.title : f.title,
        content: { body_text: "FILE_PATH:" + f.path },
        session_id: f.source_session_id,
        project: fromDb?.project || null,
        created_at: new Date(f.mtime_ms).toISOString(),
        updated_at: new Date(f.mtime_ms).toISOString(),
        attachments: [],
        // Carry the source session info (useful in Project view to show which chat made it)
        _source_session_title: f.source_session_title,
        _from_fs: true,
      };
    });

    // Non-file DB previews (emails, documents, drafts) — those keep DB-only authority
    const nonFileDbPreviews = dbPreviews.filter(p => {
      const bt = p?.content?.body_text || "";
      return !bt.startsWith("FILE_PATH:");
    });

    // Merge — fsPreviews first (newest mtime), then non-file DB previews
    const merged = [...fsPreviews, ...nonFileDbPreviews];

    const oldIds = new Set(sessionPreviews.map(p => p.id));
    sessionPreviews = merged;
    renderDrawer();
    // Badge
    const badge=document.getElementById("filesBadge");
    if(sessionPreviews.length>0){badge.textContent=sessionPreviews.length;badge.style.display="";}
    else{badge.style.display="none";}
    syncMobileFilesBadge();
    // Show new previews inline in chat
    if(showNewInline){
      for(const p of sessionPreviews){
        if(!oldIds.has(p.id)&&!knownPreviewIds.has(p.id)){
          knownPreviewIds.add(p.id);
          addInlinePreview(p);
        }
      }
    }
    sessionPreviews.forEach(p=>knownPreviewIds.add(p.id));
  }catch{}
}

function addInlinePreview(p){
  const d=mk("div","file-preview");
  const icon=p.type==="email"?"✉️":p.type==="document"?"📄":"📎";
  let html='<div class="fp-header"><span class="fp-icon">'+icon+'</span><span class="fp-title">'+esc(p.title||"Untitled")+'</span><span class="fp-type">'+esc(p.type||"file")+'</span></div>';
  if(p.content){
    const c=p.content;
    if(c.from||c.to||c.subject){
      html+='<div class="fp-inline-meta">';
      if(c.from) html+='<div>From: <span>'+esc(c.from)+'</span></div>';
      if(c.to) html+='<div>To: <span>'+esc(Array.isArray(c.to)?c.to.join(", "):c.to)+'</span></div>';
      if(c.subject) html+='<div>Subject: <span>'+esc(c.subject)+'</span></div>';
      html+='</div>';
    }
    if(c.body_text) html+=fileBodyHtml(c.body_text,p.title,null);
  }
  if(p.attachments&&p.attachments.length){
    html+='<div class="fp-attachments">'+renderAttachmentsHtml(p.id,p.attachments)+'</div>';
  }
  html+='<div class="fp-review-actions" data-pid="'+p.id+'">';
  html+='<button class="fp-approve" onclick="reviewPreview(\''+p.id+'\',\'approve\')">Approve</button>';
  html+='<button class="fp-revise" onclick="reviewPreview(\''+p.id+'\',\'revise\')">Request changes</button>';
  html+='<button class="fp-copy" onclick="copyPreviewText(\''+p.id+'\')">Copy</button>';
  html+='</div>';
  d.innerHTML=html;
  chat.appendChild(d);
  scrollToBottomIfSticky();
}

function reviewPreview(id,action){
  if(action==="approve"){
    inp.value="I approve the file \""+((sessionPreviews.find(p=>p.id===id)||{}).title||id)+"\". Proceed.";
  } else {
    inp.value="Please revise the file \""+((sessionPreviews.find(p=>p.id===id)||{}).title||id)+"\": ";
    inp.focus();
    return;
  }
  localStorage.setItem("llmt_draft",inp.value);
  send();
}

function setFileFilter(f){
  fileFilter=f;
  try{localStorage.setItem("llmt_file_filter",f)}catch{}
  document.querySelectorAll("#drawerFilters [data-ftype]").forEach(b=>b.classList.toggle("active", b.dataset.ftype === f));
  renderDrawer();
}
function setFileScope(scope){
  if (scope !== "chat" && scope !== "project") return;
  fileScope = scope;
  try{ localStorage.setItem("llmt_file_scope", scope) }catch{}
  document.querySelectorAll("#drawerFilters [data-fscope]").forEach(b=>b.classList.toggle("active", b.dataset.fscope === scope));
  refreshPreviews(false);
}
function _syncFileScopeButtons(){
  document.querySelectorAll("#drawerFilters [data-fscope]").forEach(b=>b.classList.toggle("active", b.dataset.fscope === fileScope));
  document.querySelectorAll("#drawerFilters [data-ftype]").forEach(b=>b.classList.toggle("active", b.dataset.ftype === fileFilter));
  const sel = document.getElementById("drawerSortSel");
  if (sel) sel.value = sortMode;
}

function highlightText(text, query){
  if(!query) return esc(text);
  const escaped=esc(text);
  const re=new RegExp("("+query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+")","gi");
  return escaped.replace(re,"<mark>$1</mark>");
}

function matchesSearch(p, q){
  if(!q) return true;
  const low=q.toLowerCase();
  const fields=[p.title,p.content?.body_text,p.content?.subject,p.content?.from,
    Array.isArray(p.content?.to)?p.content.to.join(" "):p.content?.to,p.type].filter(Boolean);
  return fields.some(f=>f.toLowerCase().includes(low));
}

function timeAgo(ts){
  if(!ts) return "";
  const ms=Date.now()-new Date(ts).getTime();
  if(ms<60000) return "now";
  if(ms<3600000) return Math.floor(ms/60000)+"m";
  if(ms<86400000) return Math.floor(ms/3600000)+"h";
  return Math.floor(ms/86400000)+"d";
}
function formatSize(b){if(b<1024)return b+"B";if(b<1048576)return(b/1024).toFixed(1)+"KB";return(b/1048576).toFixed(1)+"MB"}
function renderAttachmentsHtml(previewId,attachments){
  let h='';
  attachments.forEach(a=>{
    const aUrl="/api/previews/"+previewId+"/attachments/"+encodeURIComponent(a.filename);
    const isAudio=/\.(mp3|wav|m4a|ogg|webm)$/i.test(a.filename);
    if(isAudio){
      h+='<div style="margin:6px 0"><div style="font-size:11px;color:var(--dim);margin-bottom:4px">🔊 '+esc(a.filename)+(a.size?" ("+formatSize(a.size)+")":"")+'</div><audio controls preload="metadata" style="width:100%;height:36px" src="'+aUrl+'"></audio></div>';
    } else {
      h+='<a class="fp-att" href="'+aUrl+'" target="_blank">📎 '+esc(a.filename)+(a.size?" ("+formatSize(a.size)+")":"")+'</a>';
    }
  });
  return h;
}



// ── File preview modal ──
function openFileModal(title, filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const url = apiUrl('/api/file?path=' + encodeURIComponent(filePath));
  const icon = ext === 'pdf' ? '📕' : ['png','jpg','jpeg','gif','svg'].includes(ext) ? '🖼' : '📄';
  document.getElementById('fm-icon').textContent = icon;
  document.getElementById('fm-title').textContent = title;
  const link = document.getElementById('fm-open-tab');
  link.href = url;
  const body = document.getElementById('fm-body');
  // Remove old content (keep overlay)
  [...body.children].forEach(c => { if (!c.classList.contains('fm-overlay')) c.remove(); });
  let el;
  if (ext === 'pdf') {
    el = document.createElement('iframe');
    el.src = url;
    el.title = title;
  } else if (['png','jpg','jpeg','gif','svg'].includes(ext)) {
    el = document.createElement('img');
    el.src = url;
    el.alt = title;
  } else {
    el = document.createElement('pre');
    fetch(url).then(r=>r.text()).then(t=>{ el.textContent = t; }).catch(()=>{ el.textContent = 'Could not load file.'; });
  }
  body.appendChild(el);
  const modal = document.getElementById('file-modal');
  modal.classList.add('open');
  document.addEventListener('keydown', _fmKeyHandler);
  document.body.style.overflow = 'hidden';
}
function closeFileModal() {
  const modal = document.getElementById('file-modal');
  modal.classList.remove('open');
  document.removeEventListener('keydown', _fmKeyHandler);
  document.body.style.overflow = '';
  const body = document.getElementById('fm-body');
  [...body.children].forEach(c => { if (!c.classList.contains('fm-overlay')) c.remove(); });
}
function _fmKeyHandler(e) { if (e.key === 'Escape') closeFileModal(); }

function fileBodyHtml(bodyText, title, query) {
  if (!bodyText) return '';
  if (bodyText.startsWith('FILE_PATH:')) {
    var fp = bodyText.slice('FILE_PATH:'.length);
    var ext = fp.split('.').pop().toLowerCase();
    var url = apiUrl('/api/file?path=' + encodeURIComponent(fp));
    const openModal = "openFileModal('" + esc(fp.split('/').pop()).replace(/'/g,"\\'") + "','" + fp.replace(/'/g,"\\'") + "')";
    if (ext === 'pdf') {
      return '<div class="fp-pdf-wrap">'
           + '<div style="display:flex;gap:8px;margin-bottom:6px">'
           + '<button class="fm-btn" onclick="' + openModal + '" style="font-size:12px">&#x26F6; Full screen</button>'
           + '<a class="fm-btn" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" style="font-size:12px;text-decoration:none">&#8599; New tab</a>'
           + '</div>'
           + '<iframe src="' + esc(url) + '" class="fp-pdf"></iframe></div>';
    }
    if (['png','jpg','jpeg','gif','svg'].includes(ext)) {
      return '<div>'
           + '<button class="fm-btn" onclick="' + openModal + '" style="font-size:12px;margin-bottom:6px">&#x26F6; Full screen</button>'
           + '<img src="' + esc(url) + '" style="max-width:100%;border-radius:6px;display:block" loading="lazy"></div>';
    }
    if (['mp3','wav','m4a','ogg','webm','aac','flac','opus'].includes(ext)) {
      // Inline audio player — no need to open a new tab for audio review.
      return '<div class="fp-audio-wrap"><audio controls preload="metadata" src="' + esc(url) + '" style="width:100%"></audio>'
           + '<div style="font-size:10px;color:var(--dim);margin-top:4px;word-break:break-all">' + esc(fp) + '</div></div>';
    }
    return '<a class="fp-att" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">&#8599; ' + esc(fp.split('/').pop()) + '</a>';
  }
  return '<div class="fp-body">' + (query ? highlightText(bodyText, query) : esc(bodyText)) + '</div>';
}

function fileSnippet(bodyText) {
  if (!bodyText) return '';
  if (bodyText.startsWith('FILE_PATH:')) return '📄 ' + bodyText.split('/').pop();
  return bodyText.slice(0, 80).replace(/\n/g, ' ');
}

function renderDrawer(){
  const list=document.getElementById("drawerList");
  const countEl=document.getElementById("drawerCount");
  const query=(document.getElementById("drawerSearch")?.value||"").trim();
  let filtered=sessionPreviews;
  // Voice notes (user-recorded audio prompts) are hidden from the default "All"
  // view — they live in the chat thread and only show here when explicitly filtered.
  if(fileFilter==="all") filtered=filtered.filter(p=>p.type!=="voice");
  else if(fileFilter!=="all") filtered=filtered.filter(p=>p.type===fileFilter);
  if(query) filtered=filtered.filter(p=>matchesSearch(p,query));
  countEl.textContent=filtered.length+"/"+sessionPreviews.length+" files (filter="+(fileFilter||"all")+")";
  if(!filtered.length){list.innerHTML='<div class="drawer-empty">'+(query?"No matches":"No files in this session")+'</div>';return;}
  list.innerHTML="";

  // Sort + group based on sortMode
  const _ts = p => p.created_at ? new Date(p.created_at).getTime() : 0;
  const cmpNewest = (a,b) => _ts(b) - _ts(a);
  const cmpOldest = (a,b) => _ts(a) - _ts(b);
  const cmpName   = (a,b) => (a.title||"").localeCompare(b.title||"", undefined, {sensitivity:"base"});
  const cmpType   = (a,b) => {
    const ka = fileKindMeta(a).label, kb = fileKindMeta(b).label;
    return ka === kb ? cmpName(a,b) : ka.localeCompare(kb);
  };
  if (sortMode === "newest")      filtered = filtered.slice().sort(cmpNewest);
  else if (sortMode === "oldest") filtered = filtered.slice().sort(cmpOldest);
  else if (sortMode === "name")   filtered = filtered.slice().sort(cmpName);
  else if (sortMode === "type")   filtered = filtered.slice().sort(cmpType);

  // Grouping aligns with the sort: time buckets for newest/oldest, alpha for name, type label for type.
  const groups = {};
  const order = [];
  function pushGroup(name, p) {
    if (!groups[name]) { groups[name] = []; order.push(name); }
    groups[name].push(p);
  }
  if (sortMode === "newest" || sortMode === "oldest") {
    const now = Date.now();
    const buckets = ["Last hour","Today","Yesterday","This week","Older"];
    buckets.forEach(b => { groups[b]=[]; order.push(b); });
    filtered.forEach(p => {
      const t = _ts(p);
      const age = now - t;
      let bucket = "Older";
      if (age < 3600000) bucket = "Last hour";
      else if (age < 86400000) bucket = "Today";
      else if (age < 172800000) bucket = "Yesterday";
      else if (age < 604800000) bucket = "This week";
      groups[bucket].push(p);
    });
    if (sortMode === "oldest") order.reverse();
  } else if (sortMode === "type") {
    filtered.forEach(p => pushGroup(fileKindMeta(p).label, p));
  } else { // name
    filtered.forEach(p => {
      const ch = (p.title||"?").charAt(0).toUpperCase();
      pushGroup(/[A-Z]/.test(ch) ? ch : "#", p);
    });
  }

  // Capture the flat rendered order so shift-click range select and playback
  // sequence both follow the visible sort.
  _currentDrawerOrder = order.flatMap(b => (groups[b]||[]).map(p => p.id));

  order.forEach(bucket=>{
    if(!groups[bucket]||!groups[bucket].length)return;
    const grp=mk("div","drawer-group");
    const h=mk("div","drawer-group-h");h.textContent=bucket+" ("+groups[bucket].length+")";
    grp.appendChild(h);
    groups[bucket].forEach(p=>{
    const isSel = selectedPreviewIds.has(p.id);
    const meta = fileKindMeta(p);
    const card=mk("div","fp-card fp-kind-"+meta.kind+(expandedPreviewId===p.id?" active":"")+(isSel?" fp-selected":""));
    card.setAttribute("data-pid", p.id);
    const icon=meta.icon;
    const snippet=fileSnippet(p.content?.body_text||'');
    const ago=timeAgo(p.created_at);
    let html='<div class="fp-head">'
      +'<label class="fp-check" onclick="event.stopPropagation()"><input type="checkbox" '+(isSel?"checked":"")+' onclick="event.stopPropagation();toggleFileSelection(\''+p.id+'\',event)" aria-label="Attach to next message; shift+click to range select"></label>'
      +'<span class="fp-icon">'+icon+'</span><span class="fp-title">'+highlightText(p.title||"Untitled",query)+'</span><span class="fp-time">'+ago+'</span><span class="fp-type">'+esc(meta.label)+'</span>';
    // Filesystem-derived rows: no × (the row is a view of the filesystem; can't be removed
    // from the drawer without deleting the file itself, which we don't do from the UI).
    // DB-backed rows (emails, agent-labeled previews): × deletes the DB record.
    if (!p._from_fs) {
      html += '<button class="fp-row-x" onclick="event.stopPropagation();deletePreview(\''+p.id+'\')" title="Unpin from drawer" aria-label="Unpin">×</button>';
    }
    html += '</div>';
    if(expandedPreviewId!==p.id&&snippet) html+='<div class="fp-snippet">'+highlightText(snippet,query)+'</div>';
    if(expandedPreviewId===p.id){
      html+='<div class="fp-detail">';
      if(p.content){
        const c=p.content;
        if(c.from||c.to||c.subject){
          html+='<div class="fp-meta">';
          if(c.from) html+='<div>From: <span>'+highlightText(c.from,query)+'</span></div>';
          if(c.to) html+='<div>To: <span>'+highlightText(Array.isArray(c.to)?c.to.join(", "):c.to||"",query)+'</span></div>';
          if(c.subject) html+='<div>Subject: <span>'+highlightText(c.subject,query)+'</span></div>';
          html+='</div>';
        }
        if(c.body_text) html+=fileBodyHtml(c.body_text,p.title,query);
      }
      if(p.attachments&&p.attachments.length){
        html+='<div class="fp-attachments">'+renderAttachmentsHtml(p.id,p.attachments)+'</div>';
      }
      html+='</div>';
      html+='<div class="fp-actions"><button onclick="copyPreviewText(\''+p.id+'\')">Copy</button><button onclick="reviewPreview(\''+p.id+'\',\'revise\')">Revise</button><button class="danger" onclick="deletePreview(\''+p.id+'\')">Delete</button></div>';
    }
    card.innerHTML=html;
    card.querySelector(".fp-head").onclick=()=>{expandedPreviewId=expandedPreviewId===p.id?null:p.id;renderDrawer()};
    if(card.querySelector(".fp-snippet")) card.querySelector(".fp-snippet").onclick=card.querySelector(".fp-head").onclick;
    grp.appendChild(card);
    });
    list.appendChild(grp);
  });
  _updatePlayingHighlight();
}

function copyPreviewText(id){
  const p=sessionPreviews.find(x=>x.id===id);if(!p)return;
  navigator.clipboard.writeText(p.content?.body_text||p.title||"").catch(()=>{});
}
async function deletePreview(id){
  try{await fetch("/api/previews/"+id,{method:"DELETE"});await refreshPreviews(false)}catch{}
}

function toggleDrawer(){
  const dw=document.getElementById("drawer");
  dw.classList.toggle("hidden");
  try{localStorage.setItem("llmt_drawer_open",String(!dw.classList.contains("hidden")))}catch{}
  // If opening the drawer, sync filter button styling from persisted state, then refresh
  if(!dw.classList.contains("hidden")){
    try{ _syncFileScopeButtons(); }catch{}
    try{refreshPreviews(false);}catch{}
  }
}

// (decisions drawer moved to app-decisions.js)

// ── Audio Review Tool ──
let audioReviewState={}; // {rowId_lang: {flagged: Set<index>}}

async function loadAudioReview(rowId, lang){
  try{
    const res=await fetch("/api/content-planner/row/"+rowId+"/voiceover/segments",{headers:{"Origin":"http://localhost"}}).then(r=>r.json());
    const langData=res.languages?.[lang];
    if(!langData||!langData.segments?.length) return null;
    return {rowId,lang,objective:res.objective||"",tabTitle:res.tab_title||"",segments:langData.segments,voiceId:langData.voice_id};
  }catch(e){console.error(e);return null}
}

function renderAudioReview(data){
  const stateKey=data.rowId+"_"+data.lang;
  if(!audioReviewState[stateKey]) audioReviewState[stateKey]={flagged:new Set()};
  const state=audioReviewState[stateKey];

  const d=mk("div","audio-review");
  d.id="ar-"+stateKey;
  let html='<div class="ar-header"><span class="fp-icon">🎙️</span><span class="ar-title">'+esc(data.objective)+'</span><span class="ar-lang">'+esc(data.lang)+'</span></div>';
  html+='<div class="ar-segments">';
  data.segments.forEach((seg,i)=>{
    const isFlagged=state.flagged.has(seg.index);
    html+='<div class="ar-seg'+(isFlagged?" flagged":"")+'" data-idx="'+seg.index+'">';
    html+='<div class="ar-idx">#'+seg.index+'</div>';
    html+='<div class="ar-body">';
    if(seg.key) html+='<div class="ar-key">'+esc(seg.key)+'</div>';
    html+='<div class="ar-text">'+esc((seg.text||"").slice(0,200))+'</div>';
    if(seg.audio_url) html+='<audio controls preload="none" src="'+seg.audio_url+'"></audio>';
    else html+='<div style="font-size:10px;color:var(--dim);font-style:italic">No audio cached</div>';
    html+='<div class="ar-actions">';
    html+='<button class="'+(isFlagged?"flagged":"")+'" onclick="toggleSegmentFlag(\''+stateKey+'\','+seg.index+',\''+data.rowId+'\',\''+data.lang+'\')">🚩 '+(isFlagged?"Flagged":"Flag")+'</button>';
    html+='</div>';
    html+='</div></div>';
  });
  html+='</div>';
  // Regen bar
  const flagCount=state.flagged.size;
  html+='<div class="ar-regen"><span>'+(flagCount?flagCount+' flagged':'No segments flagged')+'</span>';
  if(flagCount) html+='<button onclick="regenFlagged(\''+stateKey+'\',\''+data.rowId+'\',\''+data.lang+'\')">Regenerate flagged</button>';
  html+='</div>';
  d.innerHTML=html;
  return d;
}

function toggleSegmentFlag(stateKey,index,rowId,lang){
  const state=audioReviewState[stateKey];
  if(!state) return;
  if(state.flagged.has(index)) state.flagged.delete(index);
  else state.flagged.add(index);
  // Re-render in place
  const el=document.getElementById("ar-"+stateKey);
  if(el){
    loadAudioReview(rowId,lang).then(data=>{
      if(data){
        const newEl=renderAudioReview(data);
        el.replaceWith(newEl);
      }
    });
  }
}

function regenFlagged(stateKey,rowId,lang){
  const state=audioReviewState[stateKey];
  if(!state||!state.flagged.size) return;
  const indices=[...state.flagged].sort((a,b)=>a-b);
  const msg="Regenerate voiceover segments "+indices.map(i=>"#"+i).join(", ")+" for row "+rowId+" ("+lang+"). Only these segments — do NOT regenerate any others.";
  inp.value=msg;
  localStorage.setItem("llmt_draft",inp.value);
  inp.focus();
}

// Hook: detect when Claude mentions voiceover segments in response and auto-load review
async function checkForAudioReview(text){
  if(!text) return;
  // Look for patterns like "row 2" or "row_id: 2" or "/voiceover/segments"
  const rowMatch=text.match(/row[\s_]?(?:id)?[\s:]*(\d+)/i);
  if(!rowMatch) return;
  const rowId=rowMatch[1];
  for(const lang of ["en","es"]){
    const data=await loadAudioReview(rowId,lang);
    if(data&&data.segments.length>0){
      const el=renderAudioReview(data);
      chat.appendChild(el);
      scrollToBottomIfSticky();
    }
  }
}

// Render persisted file-attachment tray on load (if any survived from a prior session).
// Deferred to DOMContentLoaded: renderSelectedTray uses mk() from app-ui-misc.js, which
// loads after this file — all classic scripts have executed by the time this fires.
document.addEventListener("DOMContentLoaded",()=>{try{renderSelectedTray()}catch{}});

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
    // Tag _batchId on audio previews — derived UI grouping per AUDIO-DRAWER-PLAN
    // §3 (NOT persisted, recomputed each refresh). batchMembersOf() reads this.
    _tagBatches(sessionPreviews);
    renderDrawer();
    // Badge
    const badge=document.getElementById("filesBadge");
    if(sessionPreviews.length>0){badge.textContent=sessionPreviews.length;badge.style.display="";}
    else{badge.style.display="none";}
    syncMobileFilesBadge();
    // Show new previews inline in chat. Cluster co-arriving audio (≥2 in same
    // batch) into ONE playlist card; everything else (singletons + non-audio)
    // renders per-file as before.
    if(showNewInline){
      const newPreviews = sessionPreviews.filter(p => !oldIds.has(p.id) && !knownPreviewIds.has(p.id));
      newPreviews.forEach(p => knownPreviewIds.add(p.id));
      const byBatch = new Map();
      const singles = [];
      for(const p of newPreviews){
        if(p._batchId){
          if(!byBatch.has(p._batchId)) byBatch.set(p._batchId, []);
          byBatch.get(p._batchId).push(p);
        } else {
          singles.push(p);
        }
      }
      for(const items of byBatch.values()){
        if(items.length >= 2) addInlineAudioBatch(items);
        else singles.push(...items);   // lone NEW arrival in an old batch — render per-file
      }
      // Sort singles back into arrival order so the chat thread isn't reordered.
      singles.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
      for(const p of singles) addInlinePreview(p);
    }
    sessionPreviews.forEach(p=>knownPreviewIds.add(p.id));
  }catch{}
}

// Tag _batchId on audio previews: same-session audio files arriving within
// a 5-second sliding window are one batch. Singleton arrivals (no sibling
// within the window) get _batchId = null.
const _BATCH_WINDOW_MS = 5000;
function _tagBatches(previews){
  const audioByTs = previews
    .filter(p => fileKindMeta(p).kind === "audio")
    .map(p => ({p, ts: p.created_at ? new Date(p.created_at).getTime() : 0}))
    .sort((a,b) => a.ts - b.ts);
  let currentId = null, prevTs = 0;
  for(const {p, ts} of audioByTs){
    if(currentId === null || (ts - prevTs) > _BATCH_WINDOW_MS) currentId = "b:" + ts;
    p._batchId = currentId;
    prevTs = ts;
  }
  // Demote singleton batches back to null so single-file arrivals render normally.
  const counts = {};
  for(const {p} of audioByTs) if(p._batchId) counts[p._batchId] = (counts[p._batchId]||0) + 1;
  for(const {p} of audioByTs) if(p._batchId && counts[p._batchId] < 2) p._batchId = null;
}

// Return the ordered list of preview ids in the same batch as `previewId`.
// Singletons (or unknown ids) return [previewId] so the caller can queue a
// one-track playback uniformly. Used by §4's row-▶ handler.
function batchMembersOf(previewId){
  const p = sessionPreviews.find(x => x.id === previewId);
  if(!p || !p._batchId) return [previewId];
  return sessionPreviews
    .filter(x => x._batchId === p._batchId)
    .sort((a,b) => new Date(a.created_at) - new Date(b.created_at))
    .map(x => x.id);
}

// Row-level ▶: play the file's batch starting at this file. Singletons
// queue length=1. Used by the drawer row button — AUDIO-DRAWER-PLAN §4.
function playFromRow(previewId){
  const ids = batchMembersOf(previewId);
  const startIdx = Math.max(0, ids.indexOf(previewId));
  const items = ids.map(id => {
    const p = sessionPreviews.find(x => x.id === id);
    if(!p) return null;
    const bt = (p.content?.body_text) || "";
    if(!bt.startsWith("FILE_PATH:")) return null;
    const fp = bt.slice("FILE_PATH:".length);
    return { id, url: apiUrl("/api/file?path=" + encodeURIComponent(fp)), title: p.title || fp.split("/").pop() };
  }).filter(Boolean);
  if(!items.length) return;
  _playbackQueue = items;
  _playbackIndex = Math.min(startIdx, items.length - 1);
  _playCurrent();
}

// Seed the playback queue with a batch starting at startIdx, then play.
// Reuses _playbackQueue / _playCurrent so the now-playing strip + skip-next +
// pause-toggle all work uniformly.
function playFromBatch(batchId, startIdx){
  const members = sessionPreviews
    .filter(p => p._batchId === batchId)
    .sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  const items = members.map(p => {
    const bt = (p.content?.body_text) || "";
    if(!bt.startsWith("FILE_PATH:")) return null;
    const fp = bt.slice("FILE_PATH:".length);
    return { id: p.id, url: apiUrl("/api/file?path=" + encodeURIComponent(fp)), title: p.title || fp.split("/").pop() };
  }).filter(Boolean);
  if(!items.length) return;
  _playbackQueue = items;
  _playbackIndex = Math.min(Math.max(0, startIdx|0), items.length - 1);
  _playCurrent();
}

// Inline playlist card for a co-arriving audio batch. Per AUDIO-DRAWER-PLAN
// §3: no auto-play — render with ▶, wait for tap. ▶ on a track plays FROM
// that track through end of batch.
function addInlineAudioBatch(items){
  if(!items || items.length < 2) return;
  const batchId = items[0]._batchId;
  const d = mk("div", "audio-batch");
  let html = '<div class="ab-header">'
           + '<span class="ab-icon">🎵</span>'
           + '<span class="ab-title">' + items.length + ' audio tracks</span>'
           + '<button class="ab-play-all" onclick="playFromBatch(\'' + esc(batchId) + '\', 0)">▶ Play all</button>'
           + '</div>'
           + '<div class="ab-tracks">';
  items.forEach((p, i) => {
    const bt = (p.content?.body_text) || "";
    const fp = bt.startsWith("FILE_PATH:") ? bt.slice("FILE_PATH:".length) : "";
    const name = (fp ? fp.split("/").pop() : (p.title || "Untitled"));
    html += '<button class="ab-track" data-pid="' + esc(p.id) + '" onclick="playFromBatch(\'' + esc(batchId) + '\',' + i + ')">'
         +    '<span class="ab-track-play">▶</span>'
         +    '<span class="ab-track-name">' + esc(name) + '</span>'
         +  '</button>';
  });
  html += '</div>';
  d.innerHTML = html;
  chat.appendChild(d);
  if(typeof scrollToBottomIfSticky === "function") scrollToBottomIfSticky();
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
  const isAudio = ['mp3','wav','m4a','ogg','webm','aac','flac','opus'].includes(ext);
  const isVideo = ['mp4','mov'].includes(ext);
  // Same staleness fix as fileBodyHtml — version non-media fetches so the
  // modal never shows a heuristically-cached copy of an edited file.
  const url = apiUrl('/api/file?path=' + encodeURIComponent(filePath)) + (isAudio || isVideo ? '' : '&v=' + Date.now());
  const icon = ext === 'pdf' ? '📕' : ['png','jpg','jpeg','gif','svg'].includes(ext) ? '🖼' : isAudio ? '🎵' : isVideo ? '🎬' : '📄';
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
  } else if (isAudio) {
    el = document.createElement('audio');
    el.controls = true;
    el.autoplay = true;
    el.preload = 'metadata';
    el.src = url;
    el.style.width = '100%';
  } else if (isVideo) {
    el = document.createElement('video');
    el.controls = true;
    el.preload = 'metadata';
    el.src = url;
    el.style.maxWidth = '100%';
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
    // /api/file sends no cache headers, so browsers heuristically cache it
    // and edited files render stale (2026-07-05: an updated plan doc kept
    // showing its pre-edit content). Version non-media fetches per render;
    // audio/video renders are immutable — keep their URLs stable and cached.
    var _mediaExts = ['mp3','wav','m4a','ogg','webm','aac','flac','opus','mp4','mov'];
    if (_mediaExts.indexOf(ext) === -1) url += '&v=' + Date.now();
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
    if (['mp4','mov'].includes(ext)) {
      return '<div class="fp-video-wrap">'
           + '<div style="display:flex;gap:8px;margin-bottom:6px">'
           + '<button class="fm-btn" onclick="' + openModal + '" style="font-size:12px">&#x26F6; Full screen</button>'
           + '<a class="fm-btn" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" style="font-size:12px;text-decoration:none">&#8599; New tab</a>'
           + '</div>'
           + '<video controls preload="metadata" playsinline src="' + esc(url) + '" style="max-width:100%;border-radius:6px;display:block"></video>'
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

// Calendar bucket for a file ≥7d old: "Jun 14" within ~30 days, "May" within
// current year, "2025" for older. Replaces the old single "Older" catch-all.
const _MONTH_ABBREV = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function _calendarBucket(t, now){
  if(!t) return "Unknown";
  const d=new Date(t), n=new Date(now);
  if(d.getFullYear() !== n.getFullYear()) return String(d.getFullYear());
  if((now - t) < 30*86400000) return _MONTH_ABBREV[d.getMonth()] + " " + d.getDate();
  return _MONTH_ABBREV[d.getMonth()];
}
function _dateBucket(t, now){
  if(!t) return "Unknown";
  const age=now - t;
  if(age < 3600000)   return "Last hour";
  if(age < 86400000)  return "Today";
  if(age < 172800000) return "Yesterday";
  if(age < 604800000) return "This week";
  return _calendarBucket(t, now);
}
// Produce a flat render plan from `filtered` (already sorted by sortMode).
// Each entry is {label, level, files, batchKey?}:
//   - "flat":  one bucket header + its files (empty label = loose, no header)
//   - "major": top-level header with no files of its own (date or type outer)
//   - "minor": sub-header + its files (batch sub-group, indented + sticky)
function _parentDirOf(p){
  const bt=p && p.content && p.content.body_text || "";
  if(!bt.startsWith("FILE_PATH:")) return null;
  const fp=bt.slice("FILE_PATH:".length);
  const i=fp.lastIndexOf("/");
  return i > 0 ? fp.slice(0, i) : null;
}
function _parentDirLabel(fullDir){
  if(!fullDir) return "";
  const parts=fullDir.split("/");
  return parts[parts.length - 1] || "";
}
// Subdivide a flat list of files by parent dir. Dirs with ≥2 files become
// "minor" sub-buckets; singletons (and orphans with no parent dir) emit as
// loose "flat" groups with no label so they render without a header.
function _splitByBatchDir(files, out){
  const byDir=new Map();
  const dirOrder=[];
  for(const p of files){
    const dir=_parentDirOf(p);
    const key=dir || "__none__";
    if(!byDir.has(key)){ byDir.set(key, []); dirOrder.push(key); }
    byDir.get(key).push(p);
  }
  for(const key of dirOrder){
    const items=byDir.get(key);
    if(key !== "__none__" && items.length >= 2){
      out.push({label: _parentDirLabel(key), level: "minor", files: items, batchKey: key});
    } else {
      for(const p of items) out.push({label: "", level: "flat", files: [p]});
    }
  }
}
function _buildRenderGroups(filtered, sortMode, _ts){
  const now=Date.now();
  const out=[];
  if(sortMode === "newest" || sortMode === "oldest"){
    // Bucket by date, then within each date sub-bucket by parent directory
    // (the natural on-disk batch boundary — files generated together land in
    // the same folder). Singletons render flush under the date header.
    const buckets=new Map();
    for(const p of filtered){
      const b=_dateBucket(_ts(p), now);
      if(!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(p);
    }
    const order=[...buckets.keys()];
    if(sortMode === "oldest") order.reverse();
    for(const label of order){
      const filesInBucket=buckets.get(label);
      // Look-ahead: do we have any batch (≥2 same-dir siblings) inside? If
      // yes, render date as MAJOR + batches as MINOR. If not, render date as
      // FLAT (current behaviour for thin buckets).
      const dirCounts=new Map();
      for(const p of filesInBucket){
        const d=_parentDirOf(p);
        if(d) dirCounts.set(d, (dirCounts.get(d) || 0) + 1);
      }
      const hasBatch=[...dirCounts.values()].some(n => n >= 2);
      if(hasBatch){
        out.push({label, level: "major", files: []});
        _splitByBatchDir(filesInBucket, out);
      } else {
        out.push({label, level: "flat", files: filesInBucket});
      }
    }
  } else if(sortMode === "type"){
    // Outer = type label (Audio / Image / …), inner = batch dirs (decided
    // 2026-06-17, then revised the same day to use batch dirs instead of
    // dates — David hunts by type then by generation batch).
    const byType=new Map();
    for(const p of filtered){
      const tl=fileKindMeta(p).label;
      if(!byType.has(tl)) byType.set(tl, []);
      byType.get(tl).push(p);
    }
    const typeOrder=[...byType.keys()].sort();
    for(const tl of typeOrder){
      out.push({label: tl, level: "major", files: []});
      _splitByBatchDir(byType.get(tl), out);
    }
  } else { // name
    const buckets=new Map();
    for(const p of filtered){
      const ch=(p.title||"?").charAt(0).toUpperCase();
      const b=/[A-Z]/.test(ch) ? ch : "#";
      if(!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(p);
    }
    const order=[...buckets.keys()].sort();
    for(const label of order) out.push({label, level: "flat", files: buckets.get(label)});
  }
  return out;
}

// Play every audio file in a batch (= files whose parent directory matches).
// Sort by created_at so playback follows generation order. Used by the ▶ on
// drawer batch sub-headers.
function playBatchByDir(parentPath){
  const items=sessionPreviews
    .filter(p => _parentDirOf(p) === parentPath)
    .filter(p => { const k=fileKindMeta(p).kind; return k === "audio" || k === "voice"; })
    .sort((a,b) => new Date(a.created_at) - new Date(b.created_at))
    .map(p => {
      const bt=(p.content && p.content.body_text) || "";
      if(!bt.startsWith("FILE_PATH:")) return null;
      const fp=bt.slice("FILE_PATH:".length);
      return { id: p.id, url: apiUrl("/api/file?path=" + encodeURIComponent(fp)), title: p.title || fp.split("/").pop() };
    })
    .filter(Boolean);
  if(!items.length) return;
  _playbackQueue=items;
  _playbackIndex=0;
  _playCurrent();
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

  // Grouping aligns with the sort: time buckets for newest/oldest, alpha for
  // name, type-then-date for type. Pipeline returns a flat render plan of
  // {label, level: "flat"|"major"|"minor", files} so the render loop is
  // uniform — type-mode shows a major header per type and minor date
  // sub-headers inside; everything else uses flat headers.
  const renderGroups = _buildRenderGroups(filtered, sortMode, _ts);

  // Capture the flat rendered order so shift-click range select and playback
  // sequence both follow the visible sort.
  _currentDrawerOrder = renderGroups.flatMap(g => g.files.map(p => p.id));

  renderGroups.forEach(g=>{
    if(g.level === "major"){
      // Type-mode major header: just the type label, no count (sum of inner
      // dates). Stands alone outside any drawer-group div so sticky works.
      const h=mk("div","drawer-group-h drawer-group-h-major");
      h.textContent=g.label;
      list.appendChild(h);
      return;
    }
    if(!g.files.length)return;
    const grp=mk("div","drawer-group"+(g.level === "minor" ? " drawer-group-minor" : ""));
    // Loose group: no label means singleton(s) that didn't fit into a batch
    // sub-bucket. Render cards directly with no header (they sit under the
    // outer date / type major).
    if(g.label){
      const h=mk("div","drawer-group-h"+(g.level === "minor" ? " drawer-group-h-minor" : ""));
      const labelEl=mk("span","drawer-group-h-label");
      labelEl.textContent=g.label+" ("+g.files.length+")";
      h.appendChild(labelEl);
      // Batch sub-headers get a play-all ▶ when the batch contains audio.
      if(g.level === "minor" && g.batchKey){
        const hasAudio=g.files.some(p => { const k=fileKindMeta(p).kind; return k === "audio" || k === "voice"; });
        if(hasAudio){
          const btn=mk("button","drawer-group-h-play");
          btn.textContent="▶";
          btn.title="Play this batch";
          btn.setAttribute("aria-label","Play batch");
          btn.onclick=(ev) => { ev.stopPropagation(); playBatchByDir(g.batchKey); };
          h.appendChild(btn);
        }
      }
      grp.appendChild(h);
    }
    g.files.forEach(p=>{
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
    // Audio/voice rows get a row-level ▶ that plays the file's BATCH (or just
    // itself for singletons) — AUDIO-DRAWER-PLAN §4. No selection required;
    // batchMembersOf() resolves siblings from the _batchId tag.
    if (meta.kind === "audio" || meta.kind === "voice") {
      html += '<button class="fp-row-play" onclick="event.stopPropagation();playFromRow(\''+p.id+'\')" title="Play batch" aria-label="Play">▶</button>';
    }
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

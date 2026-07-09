// WebSocket connection lifecycle for llmTerminal — classic script, shares
// global scope with app.js. Extracted (refactor 2026-06-10, app.js phase 3).

// Detach ALL handlers from a WebSocket before closing so in-flight messages
// can't race into the next session's view. Without this, a message arriving
// on the old socket after we've already switched `session` global runs the
// onmessage handler against the new session — and renders old content in
// the new chat. ("Voice note from another chat populated my new chat" bug.)
function _detachWs(wsRef){
  if(!wsRef) return;
  try { wsRef.onmessage = null; } catch {}
  try { wsRef.onclose   = null; } catch {}
  try { wsRef.onerror   = null; } catch {}
  try { wsRef.onopen    = null; } catch {}
  try { wsRef.close(); } catch {}
}
function _teardownAndConnect(project, sessionId){
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
  _detachWs(ws);
  // Per-chat cleanup: when leaving a session (to another or to a brand-new
  // blank one), stop in-flight audio playback and clear the file selection,
  // open file modal, and expanded card. Must happen here BEFORE `session` is
  // nulled — `connect()` can't observe the old id by the time it runs.
  const oldId = session && session.id;
  const switching = !!oldId && oldId !== sessionId;
  if (switching) {
    try { stopPlayback(); } catch {}
    try { closeFileModal(); } catch {}
    if (selectedPreviewIds.size) {
      selectedPreviewIds.clear();
      _lastSelectedId = null;
      _saveSelection();
      try { renderSelectedTray(); } catch {}
    }
    expandedPreviewId = null;
  }
  chat.innerHTML=""; session=null; ws=null; busy=false; lastRenderedTs=0; removeThinking();
  try { localStorage.setItem("llmt_project", project); } catch {}
  // Locally-queued messages are session-scoped. If we're changing sessions,
  // drop items tied to the outgoing session so the setBusy(false) drain below
  // (and the "history" handler that flips busy per server state) can't fire
  // them into the incoming chat (2026-07-03 bug).
  if (switching) {
    messageQueue = messageQueue.filter(m => m.sessionId && m.sessionId === sessionId);
    try { renderQueueCount(); } catch {}
  }
  setBusy(false);
  connect(project, sessionId);
  _updateNewSessionLabel();
}
function newSession(project){
  // Always show picker if no project given so the user picks explicitly
  // (avoids "session landed in the wrong project" surprises).
  if (!project || project === "ALL") {
    openNewSessionPicker();
    return;
  }
  localStorage.removeItem("llmt_session"); location.hash="";
  _teardownAndConnect(project, null);
}
function openNewSessionPicker(){
  const overlay = mk("div", "sb-picker-overlay");
  const sheet = mk("div", "sb-picker");
  const h = mk("h2", ""); h.textContent = "Start a new session in\u2026";
  sheet.appendChild(h);
  let suggested = "";
  if (session && session.project) suggested = session.project;
  else { try { suggested = localStorage.getItem("llmt_project") || ""; } catch {} }
  const ordered = _availableProjects.slice().sort((a, b) => {
    if (a === suggested) return -1;
    if (b === suggested) return 1;
    return a.localeCompare(b);
  });
  ordered.forEach(p => {
    const chip = mk("button", "pchip" + (p === suggested ? " recent" : ""));
    const name = mk("span", ""); name.textContent = p;
    chip.appendChild(name);
    if (p === suggested) {
      const meta = mk("span", "pchip-meta");
      meta.textContent = (session && session.project === p) ? "current chat" : "last used";
      chip.appendChild(meta);
    }
    chip.onclick = () => { overlay.remove(); newSession(p); };
    sheet.appendChild(chip);
  });
  const cancel = mk("button", "cancel"); cancel.textContent = "Cancel";
  cancel.onclick = () => overlay.remove();
  sheet.appendChild(cancel);
  overlay.appendChild(sheet);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}
function resumeSession(s){
  _teardownAndConnect(s.project, s.id);
}
async function delSession(id){
  await fetch(apiUrl("/api/sessions/"+id),{method:"DELETE"});
  if(session?.id===id){
    if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
    _detachWs(ws);
    chat.innerHTML="";session=null;ws=null;lastRenderedTs=0;
  }
  loadSessions();
}

function connect(project,sessionId){
  // Per-chat cleanup (stopPlayback / clear selection / close modal / reset
  // expanded card) happens upstream in _teardownAndConnect, where the old
  // session id is still readable. By the time this runs, `session` has
  // already been nulled.
  // Cancel any pending reconnect and bump epoch so stale handlers become no-ops
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
  const epoch=++connectEpoch;
  // Close any lingering WS without triggering its onclose reconnect
  if(ws) try{ws.onclose=null;ws.close();}catch{}
  // Protocol-level guard: lock to this connection's session_id once the server
  // identifies it. Any later message whose session_id doesn't match is dropped —
  // even if a stale WS's handlers were forgotten by _detachWs.
  let lockedSessionId = null;
  const proto=location.protocol==="https:"?"wss":"ws";
  let url=proto+"://"+location.host+BASE+"/ws?project="+project;
  if(sessionId) url+="&session="+sessionId;
  ws=new WebSocket(url);
  setStatus("connecting","thinking");
  badge.textContent=project;

  ws.onopen=()=>{
    setStatus("syncing...","thinking");
    lastServerMsgTs=Date.now();
    isSynced=false;
    // Outbox will be flushed when `ready` arrives
  };
  ws.onmessage=(e)=>{
    lastServerMsgTs=Date.now();
    const msg=JSON.parse(e.data);
    // Stale-WS guard: if this connection has already been locked to a session_id,
    // refuse any message arriving with a different one. Kills the "another chat's
    // message rendered into my new chat" race at the protocol level.
    if (lockedSessionId && msg.session_id && msg.session_id !== lockedSessionId) {
      try { console.warn("[ws] dropped stale msg", msg.type, "for", msg.session_id, "expected", lockedSessionId); } catch {}
      return;
    }
    switch(msg.type){
      case "ping":
        try{ws.send(JSON.stringify({type:"pong",ts:msg.ts}))}catch{}
        break;
      case "ack":
        if(msg.client_id){outbox=outbox.filter(m=>m.id!==msg.client_id);saveOutbox()}
        break;
      case "ready":
        isSynced=true;
        setStatus("connected","active");
        flushOutbox();
        updateSendButton();
        break;
      case "api_error":
        removeThinking();
        addApiErrorCard(msg);
        setBusy(false);
        setStatus("error","");
        try { loadSessions(); } catch {}
        break;
      case "session_summary":
        renderSummary(msg.data);
        break;
      case "session":
        session=msg.session;
        lockedSessionId = session.id;
        currentVoiceNonce = msg.voiceNonce || null;
        localStorage.setItem("llmt_session", session.id);
        localStorage.setItem("llmt_project", session.project);
        location.hash = session.id;
        markSessionViewed(session.id);
        setTopbarTitle(session.title);
        loadSessions();
        refreshPreviews(false);
        startBrowserPoll();
        if (modelSel) { modelSel.value = session.model || ""; applyModelDirty(); }
        updateStarBtn();
        try { refreshDecisionsBadge(); } catch {}
        break;
      case "history":
        // Diff-based rendering: only append messages newer than what's already on screen
        removeThinking();
        historyOffset = msg.offset || 0;
        // Reconnect with stale DOM? Clear and re-render from authoritative history.
        // Live-streamed messages use client-side timestamps that don't match the
        // server's save-time ts, so timestamp-based dedup silently fails and causes
        // duplicates (the "double message on phone unlock" bug).  A clean re-render
        // from the server's history is the only reliable path.
        const chatHadContent = !!chat.querySelector(".msg");
        if(chatHadContent){
          chat.innerHTML="";
          lastRenderedTs=0;
        }
        // Ensure a load-more bar if needed (don't duplicate)
        if(historyOffset > 0 && !chat.querySelector(".load-more-bar")){
          const bar=mk("div","load-more-bar");
          bar.textContent="Load earlier messages";
          bar.onclick=()=>loadMore();
          chat.prepend(bar);
        }
        let newestTs=lastRenderedTs;
        (msg.messages||[]).forEach(m=>{
          const ts=m.ts||0;
          if(m.role==="user"&&m.source==="voice-note") addVoiceNoteFromHistory(m);
          else if(m.role==="user") addUser(m.text, null, m.client_id || null);
          else if(m.role==="question") addQuestion(m.text, m.decisionId ? { decisionId: m.decisionId, options: m.options || [], recommend: m.recommend || null, why: m.why || null } : null);
          else if(m.role==="permission_denied") addPermissionCardFromHistory({tool_name:m.tool_name,tool_input:m.tool_input,message:m.message});
          else if(m.role==="assistant") addAssistant(m.text, { source: m.source });
          else if(m.role==="tool_activity") addToolActivityLine(m.tool_name, m.summary);
          else if(m.role==="email_draft") addEmailDraft(m);
          else if(m.role==="email_reply") addEmailReply(m, {suppressScroll: true});
          // Tag the newly-appended element with ts for future diffing
          if(ts){
            const last=chat.lastElementChild;
            if(last && !last.dataset.ts) last.dataset.ts=ts;
            if(ts>newestTs)newestTs=ts;
          }
        });
        lastRenderedTs=newestTs;
        // Server-authoritative: if a run is in flight for this session, show Stop button
        setBusy(!!msg.busy);
        setTimeout(restoreChatScroll,0);
        break;
      case "history_prepend":
        const oldH=chat.scrollHeight;
        const bar=chat.querySelector(".load-more-bar");
        if(bar) bar.remove();
        historyOffset = msg.offset || 0;
        if(historyOffset > 0){
          const nb=mk("div","load-more-bar");
          nb.textContent="Load earlier messages";
          nb.onclick=()=>loadMore();
          chat.prepend(nb);
        }
        const frag=document.createDocumentFragment();
        (msg.messages||[]).forEach(m=>{
          if(m.role==="permission_denied"){
            // Skip in prepend — already resolved
            return;
          }
          if(m.role==="tool_activity"){
            const line=mk("div","msg tool-activity-line");
            line.textContent="\u25B8 "+(m.tool_name||"?")+(m.summary?": "+m.summary:"");
            frag.appendChild(line);
            return;
          }
          if(m.role==="user"&&m.source==="voice-note"){
            frag.appendChild(buildVoiceNoteHistoryEl(m));
            return;
          }
          const d=mk("div","msg "+(m.role==="user"?"user":m.role==="question"?"question":"assistant"));
          if(m.role==="user") d.appendChild(document.createTextNode(m.text));
          else if(m.role==="question"){
            if(m.decisionId){
              renderInlineAnswerCard(d, m.text, { decisionId: m.decisionId, options: m.options || [], recommend: m.recommend || null, why: m.why || null });
            } else {
              const l=mk("div","msg-label q-label");l.textContent="Question";const b=mk("div","q-text");b.innerHTML=fmt(m.text);d.appendChild(l);d.appendChild(b);
            }
          }
          else{const b=mk("div","bubble");b.innerHTML=fmt(m.text);d.appendChild(b);}
          frag.appendChild(d);
        });
        const anchor=chat.querySelector(".load-more-bar");
        if(anchor) anchor.after(frag); else chat.prepend(frag);
        chat.scrollTop=chat.scrollHeight-oldH;
        break;
      case "status":
        if(msg.status==="connected") setStatus("syncing...","thinking");
        break;
      case "thinking":
        resetLiveBubble();
        showThinking();
        setStatus("thinking...","thinking");
        break;
      case "working":
        // Live heartbeat from the server while a turn runs — drives the
        // elapsed/last-action indicator so a slow turn doesn't look frozen.
        updateWorking(msg);
        break;
      case "text":
        // Claude's response text — show in bubble (append to existing live bubble if streaming)
        removeThinking();
        appendOrCreateAssistant(msg.text);
        break;
      case "tool_use":
        resetLiveBubble();
        if(msg.name==="AskUserQuestion"){
          removeThinking();
          const input = msg.input||{};
          const q = input.questions ? JSON.stringify(input) : (input.question || input.text || JSON.stringify(input));
          addQuestion(q);
        } else {
          addTool(msg.name, JSON.stringify(msg.input||{},null,2).slice(0,300));
        }
        break;
      case "tool_result":
        // Optionally show tool results
        break;
      case "email_draft":
        removeThinking();
        addEmailDraft(msg);
        try { loadSessions(); } catch {}
        break;
            case "queued":
        // Server confirmed it queued our prompt while busy. Treat as ack so outbox drops it.
        if (msg.client_id) {
          outbox = outbox.filter(x => x.id !== msg.client_id);
          saveOutbox();
          markUserMessageQueued(msg.client_id);
        }
        _serverQueueDepth = msg.queueDepth || 0;
        renderQueueCount();
        break;
      case "queue_state":
        _serverQueueDepth = msg.queueDepth || 0;
        renderQueueCount();
        renderPendingItems(msg.items || []);
        break;
      case "messages_deleted":
        // Server confirmed a delete. Drop the bubble(s) from DOM and, for a
        // client-side-only queued item (Claude was busy, message never made it
        // to the server), also strip the pending entry from messageQueue so
        // setBusy(false) doesn't drain and re-send it.
        {
          const cids = Array.isArray(msg.client_ids) ? msg.client_ids : [];
          for (const cid of cids) {
            if (!cid) continue;
            chat.querySelectorAll('.msg[data-client-id="'+CSS.escape(String(cid))+'"]').forEach(el => el.remove());
          }
          if (cids.length) {
            const before = messageQueue.length;
            messageQueue = messageQueue.filter(it => !cids.includes(it.clientId));
            if (messageQueue.length !== before) renderQueueCount();
          }
        }
        break;
      case "queued_prompt_firing":
        // If the bubble was already rendered locally (user typed it while connected),
        // just lift the "queued" treatment. Otherwise (cross-device, voice note,
        // automation) render a fresh user bubble now.
        {
          let fired = null;
          if (msg.client_id) {
            fired = chat.querySelector('.msg.user[data-client-id="'+CSS.escape(msg.client_id)+'"]');
          }
          if (!fired && msg.text) {
            fired = chat.querySelector('.msg.user.queued');
          }
          if (fired) {
            unmarkOldestQueuedUserMessage(msg.text);
            // Tag with the server-side ts so history replay dedupes against this bubble.
            if (msg.ts && !fired.dataset.ts) {
              fired.dataset.ts = msg.ts;
              if (msg.ts > lastRenderedTs) lastRenderedTs = msg.ts;
            }
          } else if (msg.source === "voice-note") {
            // The recording device already shows a rich local bubble — claim the
            // matching untagged one instead of double-rendering. Render fresh only
            // when none exists (other device, or page reloaded since recording).
            const locals = chat.querySelectorAll('.msg.user.voice-note-msg:not([data-ts])');
            let claimed = null;
            for (const el of locals) {
              if (msg.text && el.textContent && el.textContent.includes(msg.text.slice(0, 40))) { claimed = el; break; }
            }
            if (!claimed && locals.length) claimed = locals[0];
            if (claimed) {
              if (msg.ts) {
                claimed.dataset.ts = msg.ts;
                if (msg.ts > lastRenderedTs) lastRenderedTs = msg.ts;
              }
            } else {
              const d = addVoiceNoteFromHistory(msg);
              if (msg.ts) {
                d.dataset.ts = msg.ts;
                if (msg.ts > lastRenderedTs) lastRenderedTs = msg.ts;
              }
            }
          } else {
            const d = addUser(msg.text || "", null, msg.client_id || null);
            if (msg.ts) {
              d.dataset.ts = msg.ts;
              if (msg.ts > lastRenderedTs) lastRenderedTs = msg.ts;
            }
          }
        }
        _serverQueueDepth = Math.max(0, (_serverQueueDepth || 0) - 1);
        renderQueueCount();
        setBusy(true);
        break;
      case "permission_denied":
        addPermissionCard(msg);
        break;
      case "model_set":
        if (modelSel) {
          modelSel.value = msg.model || "";
          applyModelDirty();
        }
        break;
            case "permission_granted":
        if(msg.permission) grantedPerms.add(msg.permission);
        break;
      case "decisions_updated":
        try { refreshDecisionsBadge(); } catch {}
        try {
          const _dw = document.getElementById("decisionsDrawer");
          if (_dw && !_dw.classList.contains("hidden")) loadDecisions();
        } catch {}
        break;
      case "question_card":
        // llmt_ask posted a blocking question. Render an inline answerable
        // card in the chat scroll so David can't miss it. Also fire a
        // browser notification if the tab is backgrounded.
        try {
          if (msg.decisionId) {
            removeThinking();
            addQuestion(msg.question || "", {
              decisionId: msg.decisionId,
              options: msg.options || [],
              recommend: msg.recommend || null,
              why: msg.why || null,
            });
            refreshDecisionsBadge();
            try { loadSessions(); } catch {}
            if (document.hidden) {
              try {
                const title = (session && (session.title || session.id)) || "";
                notifyQuestion(msg.question || "", title);
              } catch {}
            }
          }
        } catch (e) { console.error("[question_card] render failed:", e); }
        break;
      case "title_updated":
        // Refresh the sidebar so the new title shows up.
        try { loadSessions(); } catch {}
        if (session && msg.sessionId === session.id) {
          session.title = msg.title;
          setTopbarTitle(msg.title);
        }
        break;
      case "permissions_state":
        grantedPerms=new Set(msg.permissions||[]);
        break;
      case "interrupted":
        setBusy(false);
        removeThinking();
        addSystemNote("Stopped.");
        try { loadSessions(); } catch {}
        break;
            case "done":
        removeThinking();
        resetLiveBubble();
        if(msg.result && !document.querySelector(".msg.assistant:last-child")){
          addAssistant(msg.result, {live:true});
        }
        refreshPreviews(true);
        // Check if response mentions voiceover/segments — auto-load audio review
        if(msg.result) checkForAudioReview(msg.result);
        // Browser notification if tab is backgrounded
        if(msg.result && document.hidden) notifyDone(msg.result);
        setBusy(false);
        setStatus("ready","active");
        // Sidebar was showing this chat as "working" (or "stalled" after 5min).
        // Server just wrote lastMessageRole="assistant"; refresh _allSessions so
        // the sidebar snaps to "responded" instead of staying stale until a
        // refresh. Was David's "the answer was there but the chat said stale" bug.
        try { loadSessions(); } catch {}
        break;
      case "idle":
        removeThinking();
        resetLiveBubble();
        setBusy(false);
        setStatus("ready","active");
        try { loadSessions(); } catch {}
        break;
      case "error":
        removeThinking();
        addError(msg.message);
        setBusy(false);
        setStatus("error","");
        try { loadSessions(); } catch {}
        break;
      case "exit":
        addSystem("Session ended");
        setBusy(false);
        break;
    }
  };
  ws.onclose=()=>{
    setStatus("reconnecting...","thinking"); ws=null;
    currentVoiceNonce=null; // server already revoked it; clear locally so we don't POST with a known-bad token
    // Auto-reconnect — but only if this connection is still the current epoch
    const closedEpoch=epoch;
    reconnectTimer=setTimeout(()=>{
      reconnectTimer=null;
      if(closedEpoch!==connectEpoch) return; // session switched since this ws closed
      if(!ws&&session){
        // Don't pre-emptively wipe chat.innerHTML: the incoming `history` event
        // handles wipe-and-re-render if it sees existing content. Wiping here
        // caused a visible blank-chat flash on every auto-reconnect ("the chat
        // is inactive, refresh, and the answer was there" report 2026-07-04).
        connect(session.project,session.id);
      }
    },2000);
  };
  ws.onerror=()=>setStatus("error","");
  // Staleness watcher: if server hasn't sent anything for 25s show slow, 45s force reconnect
  if(staleTimer) clearInterval(staleTimer);
  staleTimer=setInterval(()=>{
    if(!ws||ws.readyState!==1) return;
    const age=Date.now()-lastServerMsgTs;
    if(age>45000){console.log("[heartbeat] stale>45s, forcing reconnect");try{ws.close()}catch{}}
    else if(age>25000){setStatus("slow...","thinking")}
  },5000);
}

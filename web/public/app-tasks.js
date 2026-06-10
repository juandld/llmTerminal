// Task-board panel (orchestrator tasks) for llmTerminal — classic script,
// shares global scope with app.js. Extracted (refactor 2026-06-10, app.js phase 8).

function toggleTaskBoard(){
  const tb=document.getElementById("taskBoard");
  tb.classList.toggle("hidden");
  if(!tb.classList.contains("hidden")) loadTasks();
}
function setTaskFilter(f){
  taskFilter=f;
  document.querySelectorAll("#taskFilters button").forEach(b=>b.classList.toggle("active",b.dataset.tf===f));
  renderTasks();
}
async function loadTasks(){
  try{
    const r=await fetch("./api/tasks?limit=100");
    if(!r.ok) throw new Error(""+r.status);
    const data=await r.json();
    taskCache=data.items||[];
    renderTasks();
    updateTaskBadge();
  }catch(err){
    document.getElementById("taskList").innerHTML='<div class="drawer-empty">Failed to load tasks</div>';
    console.error("[tasks]",err);
  }
}
function renderTasks(){
  const list=document.getElementById("taskList");
  const actionable=["blocked","review","new"];
  const active=["in_progress","queued","triaged"];
  let items=taskCache;
  if(taskFilter==="actionable") items=items.filter(t=>actionable.includes(t.status));
  else if(taskFilter==="active") items=items.filter(t=>active.includes(t.status)||actionable.includes(t.status));
  // Group by project
  const groups={};
  items.forEach(t=>{
    const p=t.target_project||t.project_id||"other";
    if(!groups[p])groups[p]=[];
    groups[p].push(t);
  });
  if(!items.length){
    list.innerHTML='<div class="drawer-empty">No tasks match filter</div>';
    document.getElementById("taskCount").textContent="";
    return;
  }
  document.getElementById("taskCount").textContent=items.length;
  let html="";
  for(const [proj,tasks] of Object.entries(groups).sort()){
    html+='<div class="tk-group"><div class="tk-proj">'+esc(proj)+'</div>';
    tasks.forEach(t=>{
      const statusCls="tk-s-"+t.status;
      const pri=t.priority==="urgent"?"!!! ":t.priority==="high"?"!! ":"";
      html+='<div class="tk-item '+statusCls+'" data-tid="'+t.task_id+'">';
      html+='<div class="tk-title" onclick="loadTaskIntoChat(this.parentNode)">'+esc(pri+t.title)+'</div>';
      html+='<div class="tk-meta"><span class="tk-status">'+esc(t.status)+'</span>';
      if(t.blocked_reason) html+='<span class="tk-blocked">'+esc(t.blocked_reason.slice(0,40))+'</span>';
      html+='<span class="tk-date">'+new Date(t.created_at).toLocaleDateString()+'</span></div>';
      // Action buttons based on status
      html+='<div class="tk-actions">';
      if(t.status==="blocked") html+='<button class="tk-btn tk-btn-retry" onclick="taskAction(\''+t.task_id+'\',\'retry\')">↻ Retry</button>';
      if(t.status==="blocked") html+='<button class="tk-btn tk-btn-close" onclick="taskAction(\''+t.task_id+'\',\'close\')">✕ Close</button>';
      if(t.status==="review") html+='<button class="tk-btn tk-btn-approve" onclick="taskAction(\''+t.task_id+'\',\'merge\')">✓ Approve</button>';
      if(t.status==="review") html+='<button class="tk-btn tk-btn-close" onclick="taskAction(\''+t.task_id+'\',\'close\')">✕ Close</button>';
      if(t.status==="new") html+='<button class="tk-btn tk-btn-retry" onclick="taskAction(\''+t.task_id+'\',\'queue\')">▶ Queue</button>';
      if(t.status==="new") html+='<button class="tk-btn tk-btn-close" onclick="taskAction(\''+t.task_id+'\',\'close\')">✕ Close</button>';
      if(t.status==="in_progress") html+='<button class="tk-btn" onclick="loadTaskIntoChat(this.closest(\'.tk-item\'))">💬 Open</button>';
      html+='</div>';
      html+='</div>';
    });
    html+='</div>';
  }
  list.innerHTML=html;
}
function updateTaskBadge(){
  const actionable=taskCache.filter(t=>["blocked","review","new"].includes(t.status));
  const n=actionable.length;
  ["tasksBadge","tasksBadgeMobile"].forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.textContent=n;el.style.display=n?"":"none";}
  });
}
function loadTaskIntoChat(el){
  const tid=el.dataset.tid;
  const t=taskCache.find(t=>t.task_id===tid);
  if(!t) return;
  const desc=(t.description||"").slice(0,500);
  const text="[Task: "+t.title+"]\nProject: "+(t.target_project||t.project_id)+"\nStatus: "+t.status
    +(t.blocked_reason?"\nBlocked: "+t.blocked_reason:"")
    +(desc?"\n\n"+desc:"")
    +"\n\nWhat should we do with this?";
  inp.value=text;
  autoResizeInput(inp);
  localStorage.setItem("llmt_draft",inp.value);
  // Link this session to the task
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:"link_task",task_id:tid}));
  toggleTaskBoard();
  if(window.innerWidth>768) inp.focus();
}
// ── Floating Action Button (FAB) — round-robin + quick actions ──
(function(){
  const fab=document.getElementById("fab");
  if(!fab)return;
  const fabCount=document.getElementById("fabCount");
  let isDragging=false, dragStartX=0, dragStartY=0, fabX=0, fabY=0, pressTimer=null;
  // Restore position
  try{const p=JSON.parse(localStorage.getItem("llmt_fab_pos"));if(p){fab.style.right="auto";fab.style.left=p.x+"px";fab.style.top=p.y+"px";fab.style.bottom="auto";}}catch{}

  function updateFabCount(){
    const n=attentionSessionsList().length;
    fabCount.textContent=n;
    fab.classList.toggle("fab-zero",n===0);
  }
  // Expose for polling
  window._updateFabCount=updateFabCount;
  setTimeout(updateFabCount,1500);

  // Tap = next attention session
  fab.addEventListener("click",(e)=>{
    if(isDragging)return;
    nextAttentionSession();
  });

  // Drag support (touch)
  fab.addEventListener("touchstart",(e)=>{
    if(e.touches.length!==1)return;
    const t=e.touches[0];
    dragStartX=t.clientX;dragStartY=t.clientY;
    const r=fab.getBoundingClientRect();
    fabX=r.left;fabY=r.top;
    isDragging=false;
    pressTimer=setTimeout(()=>{showFabMenu();pressTimer=null;},500);
  },{passive:true});
  fab.addEventListener("touchmove",(e)=>{
    if(e.touches.length!==1)return;
    const t=e.touches[0];
    const dx=t.clientX-dragStartX,dy=t.clientY-dragStartY;
    if(Math.abs(dx)>5||Math.abs(dy)>5){
      isDragging=true;
      if(pressTimer){clearTimeout(pressTimer);pressTimer=null;}
      fab.classList.add("fab-dragging");
      fab.style.right="auto";fab.style.bottom="auto";
      fab.style.left=Math.max(0,Math.min(window.innerWidth-60,fabX+dx))+"px";
      fab.style.top=Math.max(0,Math.min(window.innerHeight-60,fabY+dy))+"px";
    }
  },{passive:true});
  fab.addEventListener("touchend",(e)=>{
    if(pressTimer){clearTimeout(pressTimer);pressTimer=null;}
    fab.classList.remove("fab-dragging");
    if(isDragging){
      // Save position
      try{localStorage.setItem("llmt_fab_pos",JSON.stringify({x:parseInt(fab.style.left),y:parseInt(fab.style.top)}));}catch{}
      setTimeout(()=>{isDragging=false;},50);
    }
  },{passive:true});

  // Long-press (mouse)
  fab.addEventListener("mousedown",(e)=>{
    pressTimer=setTimeout(()=>{
      const r=fab.getBoundingClientRect();
      showFabMenu();
      pressTimer=null;
    },500);
  });
  fab.addEventListener("mouseup",()=>{if(pressTimer){clearTimeout(pressTimer);pressTimer=null;}});

  // FAB context menu
  function showFabMenu(){
    const fabRect=fab.getBoundingClientRect();
    // "First gear" — Mark done — sits just BELOW the FAB
    let downMenu=document.getElementById("fabMenuDown");
    if(!downMenu){downMenu=mk("div","fab-menu fab-menu-down");downMenu.id="fabMenuDown";document.body.appendChild(downMenu);}
    downMenu.innerHTML='<button class="fab-menu-item" data-act="mark-done">✅ Done</button>';
    downMenu.style.right=(window.innerWidth-fabRect.right)+"px";
    downMenu.style.top=(fabRect.bottom+6)+"px";
    downMenu.style.display="block";
    // "Upper gears" — sessions needing input — stack ABOVE the FAB
    let upMenu=document.getElementById("fabMenuUp");
    if(!upMenu){upMenu=mk("div","fab-menu fab-menu-up");upMenu.id="fabMenuUp";document.body.appendChild(upMenu);}
    const list=attentionSessionsList();
    let html="";
    if(list.length===0) html='<div class="fab-menu-item" style="color:var(--dim)">All clear</div>';
    list.slice(0,8).forEach(s=>{
      const st=computeSessionState(s);
      const icon=STATE_ICONS[st]||"";
      html+='<button class="fab-menu-item" data-sid="'+s.id+'">'+icon+' '+esc((s.title||"Untitled").slice(0,30))+'</button>';
    });
    upMenu.innerHTML=html;
    upMenu.style.right=(window.innerWidth-fabRect.right)+"px";
    upMenu.style.bottom=(window.innerHeight-fabRect.top+6)+"px";
    upMenu.style.display="block";
    // Shared click handler
    const handler=(e)=>{
      const btn=e.target.closest("[data-sid],[data-act]");
      if(btn&&btn.dataset.sid){
        const s=_allSessions.find(s=>s.id===btn.dataset.sid);
        if(s){resumeSession(s);showAttentionBanner(s);}
      }
      if(btn&&btn.dataset.act==="mark-done"&&session){
        fetch(apiUrl("/api/sessions/"+session.id+"/state"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({manualDone:true})}).then(()=>{
          loadSessions().then(()=>{
            if(window._updateFabCount)window._updateFabCount();
            nextAttentionSession();
          });
        });
      }
      closeFabMenus();
    };
    upMenu.onclick=handler;
    downMenu.onclick=handler;
    setTimeout(()=>{
      const closer=(e)=>{if(!e.target.closest(".fab-menu")&&!e.target.closest(".fab"))closeFabMenus();};
      document.addEventListener("click",closer,{once:true});
      document.addEventListener("touchstart",closer,{once:true,passive:true});
    },50);
  }
  function closeFabMenus(){
    const up=document.getElementById("fabMenuUp"),down=document.getElementById("fabMenuDown");
    if(up)up.style.display="none";
    if(down)down.style.display="none";
  }
})();

function _transitionTask(taskId, status, detail){
  return fetch("./api/tasks/"+taskId+"/transition",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status,detail})});
}
async function retryAllBlocked(){
  const blocked=taskCache.filter(t=>t.status==="blocked");
  if(!blocked.length){alert("No blocked tasks");return;}
  let ok=0;
  for(const t of blocked){
    try{ const r=await _transitionTask(t.task_id,"queued","Bulk retry from task board"); if(r.ok) ok++; }catch{}
  }
  console.log("[tasks] retried "+ok+"/"+blocked.length+" blocked tasks");
  loadTasks();
}
async function taskAction(taskId,action){
  const map={retry:["queued","Retried from task board"],close:["closed","Closed from task board"],merge:["merged","Approved from task board"],queue:["queued","Queued from task board"]};
  const args=map[action];
  if(!args) return;
  try{ await _transitionTask(taskId,args[0],args[1]); loadTasks(); }catch(err){console.error("[task-action]",err);}
}

// Auto-load task count on page load
setTimeout(()=>{
  fetch("./api/tasks?limit=100").then(r=>r.json()).then(data=>{
    taskCache=data.items||[];
    updateTaskBadge();
  }).catch(()=>{});
},2000);

// Poll sidebar state every 15s — shows real-time status of all chats
setInterval(()=>{
  fetch(apiUrl("/api/sessions?project=ALL")).then(r=>r.json()).then(sessions=>{
    // Only re-render if something changed
    const changed = sessions.some((s,i) => {
      const old = _allSessions[i];
      return !old || old.lastMessageRole !== s.lastMessageRole || old.lastSnippet !== s.lastSnippet || old.lastActive !== s.lastActive;
    }) || sessions.length !== _allSessions.length;
    if (changed) { _allSessions = sessions; _renderSidebar(); refreshAttentionCounter(); if(window._updateFabCount)window._updateFabCount(); }
  }).catch(()=>{});
}, 15000);

// (TTS playback moved to app-tts.js)

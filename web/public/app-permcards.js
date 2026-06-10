// Permission request cards — classic script, shares global scope with app.js.
// Extracted (refactor 2026-06-10).

function describePermAction(msg){
  const name=msg.tool_name||"unknown",input=msg.tool_input||{};
  if(name==="Write") return "write to "+(input.file_path||"a file");
  if(name==="Edit") return "edit "+(input.file_path||"a file");
  if(name==="Bash") return "run: "+(input.command||"a command").slice(0,120);
  if(name==="Read") return "read "+(input.file_path||"a file");
  if(name==="Glob"||name==="Grep") return name.toLowerCase()+" search";
  // MCP tools: show a cleaner name like "Gmail: search messages"
  if(name.startsWith("mcp__")){
    const parts=name.split("__");
    const service=parts[1]||"";
    const action=(parts[2]||"").replace(/_/g," ");
    return service+": "+action+" "+JSON.stringify(input).slice(0,80);
  }
  return name+" "+JSON.stringify(input).slice(0,100);
}
function buildPermString(msg){
  const name=msg.tool_name||"";
  if(name==="Bash"&&msg.tool_input?.command){
    const cmd=msg.tool_input.command.split(" ")[0];
    return "Bash("+cmd+":*)";
  }
  return name;
}
function grantPerm(perm){
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:"permission_grant",permission:perm}));
}
function grantAllPerms(extraPerm){
  // Grant all common tool permissions + any MCP tool that triggered this
  const allPerms=["Read","Write","Edit","Glob","Grep","Bash","Agent","WebFetch","WebSearch","NotebookEdit","Bash(*:*)"];
  if(extraPerm&&!allPerms.includes(extraPerm)) allPerms.push(extraPerm);
  // Send all at once but only auto-retry on the last one
  for(let i=0;i<allPerms.length;i++){
    if(ws&&ws.readyState===1){
      const isLast=i===allPerms.length-1;
      ws.send(JSON.stringify({type:"permission_grant",permission:allPerms[i],autoRetry:isLast}));
    }
  }
}
function addPermissionCard(msg){
  removeThinking();
  const d=mk("div","msg permission");
  const label=mk("div","msg-label perm-label");label.textContent="Permission Required";
  const tool=mk("div","perm-tool");tool.textContent=describePermAction(msg);
  const detail=mk("div","perm-detail");detail.textContent=msg.message||"";
  const actions=mk("div","perm-actions");
  const allow=mk("button","perm-btn perm-allow");allow.textContent="Allow";
  const allowAll=mk("button","perm-btn perm-allow");allowAll.textContent="Allow All";allowAll.title="Grant all permissions for this session";
  const deny=mk("button","perm-btn perm-deny");deny.textContent="Deny";
  allow.onclick=()=>{
    const perm=buildPermString(msg);
    grantPerm(perm);
    actions.innerHTML='<span class="perm-result allowed">Allowed — retrying automatically...</span>';
  };
  allowAll.onclick=()=>{
    const thisPerm=buildPermString(msg);
    grantAllPerms(thisPerm);
    actions.innerHTML='<span class="perm-result allowed">All permissions granted — retrying automatically...</span>';
  };
  deny.onclick=()=>{
    actions.innerHTML='<span class="perm-result denied">Denied</span>';
  };
  actions.appendChild(allow);actions.appendChild(allowAll);actions.appendChild(deny);
  d.appendChild(label);d.appendChild(tool);d.appendChild(detail);d.appendChild(actions);
  chat.appendChild(d);scrollToBottomForce();
}
function addPermissionCardFromHistory(msg){
  // Check if this permission is currently in the granted set
  const perm=buildPermString({tool_name:msg.tool_name,tool_input:msg.tool_input});
  const isGranted=grantedPerms&&grantedPerms.has(perm);
  const d=mk("div","msg permission");
  const label=mk("div","msg-label perm-label");label.textContent="Permission Required";
  const tool=mk("div","perm-tool");tool.textContent=describePermAction({tool_name:msg.tool_name,tool_input:msg.tool_input});
  const detail=mk("div","perm-detail");detail.textContent=msg.message||"";
  d.appendChild(label);d.appendChild(tool);d.appendChild(detail);
  if(isGranted){
    const res=mk("div","perm-result allowed");res.textContent="(allowed)";
    d.appendChild(res);
  }else{
    // Still needs grant — show actionable buttons
    const actions=mk("div","perm-actions");
    const allow=mk("button","perm-btn perm-allow");allow.textContent="Allow";
    const allowAll=mk("button","perm-btn perm-allow");allowAll.textContent="Allow All";
    allow.onclick=()=>{grantPerm(perm);actions.innerHTML='<span class="perm-result allowed">Allowed — send a message to retry</span>';};
    allowAll.onclick=()=>{grantAllPerms(perm);actions.innerHTML='<span class="perm-result allowed">All permissions granted — send a message to retry</span>';};
    actions.appendChild(allow);actions.appendChild(allowAll);
    d.appendChild(actions);
  }
  chat.appendChild(d);
}

let sessionPreviews=[], expandedPreviewId=null, fileFilter="all", knownPreviewIds=new Set();
let sortMode=(function(){try{return localStorage.getItem("llmt_file_sort")||"newest"}catch{return "newest"}})(); // newest|oldest|name|type

// Map a preview entry to a {kind, icon, label} based on type or filename extension.
// Drives both the visible icon and the .fp-kind-* CSS class for the color accent.
// (files-drawer fns moved to app-drawer.js)

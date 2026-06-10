// Message helpers (tool/system/error/thinking/markdown-table) — classic script, shares global scope with app.js.
// Extracted (refactor 2026-06-10).

function addTool(name,body){
  // Mark any previously-running tool entry as settled — we're moving on.
  const prev = chat.querySelector(".msg.tool.running:last-of-type");
  if (prev) prev.classList.remove("running");
  const d=mk("div","msg tool running");
  const n=mk("div","tool-name");
  n.innerHTML='<span class="tool-spinner" aria-hidden="true">⟳</span><span class="tool-name-text"></span>';
  n.querySelector(".tool-name-text").textContent = name;
  const b=mk("div","tool-body"); b.textContent=body;
  d.appendChild(n); d.appendChild(b);
  chat.appendChild(d);
  scrollToBottomIfSticky();
}
function addSystem(text){const d=mk("div","msg system");d.textContent=text;chat.appendChild(d)}
// Render a locally-queued (client busy) message as a real user bubble with the
// same dashed-yellow "queued" treatment we use for server-broadcast queue items.
// Keeps the visual identical whether the queue lives client-side or server-side
// so David can always see *what* is pending, not just a depth count.
function addQueued(text,imagePreviews,clientId){
  const d=mk("div","msg user queued");
  if(clientId) d.dataset.clientId=clientId;
  d.dataset.localQueued="1";
  if(imagePreviews&&imagePreviews.length){
    imagePreviews.forEach(src=>{const img=document.createElement("img");img.src=src;d.appendChild(img)});
  }
  d.appendChild(document.createTextNode(text));
  const badge=mk("span","queued-badge");
  badge.textContent="queued — will fire when current turn ends";
  badge.title="Held client-side because Claude is still mid-turn. It will send automatically as soon as the current response finishes.";
  d.appendChild(badge);
  chat.appendChild(d);
  scrollToBottomIfSticky();
}
function renderQueueCount(){
  const total = (messageQueue?.length || 0) + (_serverQueueDepth || 0);
  let el=document.getElementById("queueCount");
  if(!el){el=mk("span","queue-count");el.id="queueCount";document.querySelector(".topbar").appendChild(el)}
  el.textContent = total ? (total + " queued") : "";
  el.classList.toggle("has-queue", total > 0);
  el.title = total
    ? "Pending messages waiting for Claude to finish — they will fire automatically."
    : "";
}
function addError(text){const d=mk("div","msg error");d.textContent="Error: "+text;chat.appendChild(d);scrollToBottomForce()}

// Permission functions defined above (consolidated)

function showThinking(){
  removeThinking();
  thinkingEl=mk("div","thinking-indicator");
  thinkingEl.textContent="thinking";
  chat.appendChild(thinkingEl);
  scrollToBottomIfSticky();
}
function removeThinking(){if(thinkingEl){thinkingEl.remove();thinkingEl=null;}}

function fmtTable(block){
  const rows=block.trim().split('\n').filter(r=>r.trim());
  if(rows.length<2)return null;
  // check separator row (---|---|---)
  const sep=rows[1].trim().replace(/^\|/,'').replace(/\|$/,'');
  if(!/^[\s:|-]+$/.test(sep))return null;
  const parse=r=>r.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
  const heads=parse(rows[0]);
  let html='<div class="md-table-wrap"><table><thead><tr>';
  heads.forEach(h=>{html+='<th>'+h+'</th>';});
  html+='</tr></thead><tbody>';
  for(let i=2;i<rows.length;i++){
    const cells=parse(rows[i]);
    html+='<tr>';
    cells.forEach(c=>{html+='<td>'+c+'</td>';});
    html+='</tr>';
  }
  html+='</tbody></table></div>';
  return html;
}

function fmt(text){
  let h=esc(text);
  h=h.replace(/```(\w*)\n([\s\S]*?)```/g,(m,lang,code)=>{
    const enc=encodeURIComponent(code);
    return '<div class="code-block"><button class="code-copy" data-code="'+enc+'" onclick="copyCodeFromBtn(this)">Copy</button><pre><code>'+code+'</code></pre></div>';
  });
  // Parse markdown tables before line breaks
  h=h.replace(/(^|\n)(\|.+\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.+\|[ \t]*(?:\n|$))+)/gm,(m,pre,tbl)=>{
    const rendered=fmtTable(tbl);
    return rendered?(pre+rendered):(pre+tbl);
  });
  h=h.replace(/`([^`]+)`/g,'<code>$1</code>');
  h=h.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  h=h.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<span class="link-island"><a href="$2" target="_blank" rel="noopener">$1</a></span>');
  h=h.replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g,'$1<span class="link-island"><a href="$2" target="_blank" rel="noopener">$2</a></span>');
  h=h.replace(/\n/g,'<br>');
  return h;
}

function addSystemNote(text){
  const d=document.createElement('div');
  d.className='msg system-note';
  d.textContent=text;
  d.style.cssText='align-self:center;font-size:11px;color:var(--dim);font-style:italic;padding:4px 12px;opacity:.7';
  chat.appendChild(d);
  scrollToBottomIfSticky && scrollToBottomIfSticky();
}

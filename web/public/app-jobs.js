// app-jobs.js — Jobs ledger view: live glass-box status of long-running tasks.
// Reads /api/jobs (the same substrate the orchestrator uses). Classic script,
// shares global scope with app.js. (ARCHITECTURE.md §4 continuity.)
let _jobsTimer = null;
function toggleJobs(){
  const d = document.getElementById("jobsDrawer");
  if(!d) return;
  const opening = d.classList.contains("hidden");
  d.classList.toggle("hidden");
  if(opening){ loadJobs(); _jobsTimer = setInterval(loadJobs, 3000); }
  else if(_jobsTimer){ clearInterval(_jobsTimer); _jobsTimer = null; }
}
async function loadJobs(){
  try{ const r = await fetch("./api/jobs"); if(r.ok) renderJobs(await r.json()); }catch(e){}
}
function _jobIcon(s){ return ({running:"🟢",stalled:"⚠️",done:"✓",failed:"✗",killed:"✗",queued:"•"})[s] || "•"; }
function _jobAgo(ms){ const s=Math.round((Date.now()-ms)/1000); return s<60?s+"s":s<3600?Math.round(s/60)+"m":Math.round(s/3600)+"h"; }
function renderJobs(jobs){
  const el = document.getElementById("jobsList"); if(!el) return;
  if(!jobs || !jobs.length){ el.innerHTML = '<div class="drawer-empty">No jobs yet — long-running tasks appear here live.</div>'; return; }
  el.innerHTML = jobs.map(j=>{
    const age = _jobAgo(j.last_beat || j.started_at);
    const live = (j.status==="running" || j.status==="stalled");
    return '<div class="job-row js-'+esc(j.status)+'">'
      + '<div class="job-line"><span class="job-ic">'+_jobIcon(j.status)+'</span>'
      + '<span class="job-label">'+esc(j.label||j.id)+'</span>'
      + '<span class="job-prog">'+esc(j.progress||j.status)+'</span>'
      + '<span class="job-age">'+(live?"upd "+age:age+" ago")+'</span></div>'
      + (j.note?'<div class="job-note">'+esc(j.note)+'</div>':'')
      + '</div>';
  }).join("");
}

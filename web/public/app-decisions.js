// Decisions drawer (timeline / tree of agent decisions) — classic script,
// shares global scope with app.js. Extracted (refactor 2026-06-10, app.js phase 5).

// ── Decisions drawer (timeline / tree of agent decisions) ──
let _decisions = [];
let _decisionsView  = (function(){try{return localStorage.getItem("llmt_decisions_view")||"timeline"}catch{return "timeline"}})();
let _decisionsScope = (function(){try{return localStorage.getItem("llmt_decisions_scope")||"project"}catch{return "project"}})();
const _decisionsExpanded = new Set();

function _bumpDecisionsViewCount(view){
  try {
    const k = "llmt_decisions_view_count_" + view;
    const n = (parseInt(localStorage.getItem(k) || "0", 10) || 0) + 1;
    localStorage.setItem(k, String(n));
  } catch {}
}

function toggleDecisionsDrawer(){
  const dw = document.getElementById("decisionsDrawer");
  if (!dw) return;
  dw.classList.toggle("hidden");
  const open = !dw.classList.contains("hidden");
  try{ localStorage.setItem("llmt_decisions_open", String(open)) }catch{}
  if (open) {
    _syncDecisionsFilterButtons();
    _bumpDecisionsViewCount(_decisionsView);
    loadDecisions();
  }
}

function setDecisionsView(view){
  if (view !== "timeline" && view !== "tree") return;
  _decisionsView = view;
  try{ localStorage.setItem("llmt_decisions_view", view) }catch{}
  _bumpDecisionsViewCount(view);
  _syncDecisionsFilterButtons();
  renderDecisions();
}

function setDecisionsScope(scope){
  if (scope !== "session" && scope !== "project") return;
  _decisionsScope = scope;
  try{ localStorage.setItem("llmt_decisions_scope", scope) }catch{}
  _syncDecisionsFilterButtons();
  loadDecisions();
}

function _syncDecisionsFilterButtons(){
  document.querySelectorAll("#decisionsFilters [data-dv]").forEach(b => b.classList.toggle("active", b.dataset.dv === _decisionsView));
  document.querySelectorAll("#decisionsFilters [data-dv-scope]").forEach(b => b.classList.toggle("active", b.dataset.dvScope === _decisionsScope));
}

async function loadDecisions(){
  const list = document.getElementById("decisionsList");
  if (!list) return;
  let url;
  if (_decisionsScope === "project") {
    if (!session || !session.project) {
      list.innerHTML = '<div class="drawer-empty">No project selected</div>';
      return;
    }
    url = apiUrl("/api/projects/" + encodeURIComponent(session.project) + "/decisions");
  } else {
    if (!session || !session.id) {
      list.innerHTML = '<div class="drawer-empty">Open a chat first</div>';
      return;
    }
    url = apiUrl("/api/sessions/" + session.id + "/decisions");
  }
  try {
    const r = await fetch(url);
    const data = await r.json();
    _decisions = Array.isArray(data.decisions) ? data.decisions : [];
  } catch (e) {
    _decisions = [];
    list.innerHTML = '<div class="drawer-empty">Failed to load decisions</div>';
    return;
  }
  renderDecisions();
}

function renderDecisions(){
  const list = document.getElementById("decisionsList");
  const cnt  = document.getElementById("decisionsCount");
  if (!list) return;
  if (cnt) cnt.textContent = _decisions.length ? String(_decisions.length) : "";
  if (!_decisions.length) {
    list.innerHTML = '<div class="drawer-empty">No decisions recorded yet. Agents call <code>llmt_decide</code> to add them.</div>';
    return;
  }
  if (_decisionsView === "tree") {
    list.innerHTML = _renderTreeHtml(_decisions);
  } else {
    list.innerHTML = _renderTimelineHtml(_decisions);
  }
  // Wire expand toggles
  list.querySelectorAll(".dec-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("a") || e.target.closest("button")) return;
      const id = row.dataset.did;
      if (_decisionsExpanded.has(id)) _decisionsExpanded.delete(id);
      else _decisionsExpanded.add(id);
      renderDecisions();
    });
  });
}

function _decStatusClass(s){ return "dec-status-" + (s || "pending"); }
function _decStatusIcon(s){
  return s === "verified" ? "✓"
       : s === "reversed" ? "↺"
       : s === "mined"    ? "~"
       : "•";
}

function _renderDecisionRow(d, depth){
  const id = String(d.id);
  const expanded = _decisionsExpanded.has(id);
  const indent = depth ? `style="margin-left:${depth * 18}px"` : "";
  const stClass = _decStatusClass(d.status);
  const ic = _decStatusIcon(d.status);
  let body = "";
  if (expanded) {
    const alts = Array.isArray(d.alternatives) && d.alternatives.length
      ? d.alternatives.map(a => `<li>${esc(a)}</li>`).join("")
      : "<li class=\"dec-empty\">(none recorded)</li>";
    const cons = Array.isArray(d.constraints) && d.constraints.length
      ? `<div class="dec-section"><div class="dec-label">Constraints</div><ul>${d.constraints.map(c => `<li>${esc(c)}</li>`).join("")}</ul></div>`
      : "";
    const cost = d.cost ? `<div class="dec-section"><div class="dec-label">Cost</div><div>${esc(d.cost)}</div></div>` : "";
    let arts = "";
    if (d.artifacts) {
      try {
        const parts = [];
        for (const [k, v] of Object.entries(d.artifacts)) {
          if (Array.isArray(v)) parts.push(`<li><b>${esc(k)}:</b><ul>${v.map(x => `<li>${esc(x)}</li>`).join("")}</ul></li>`);
          else parts.push(`<li><b>${esc(k)}:</b> ${esc(typeof v === "string" ? v : JSON.stringify(v))}</li>`);
        }
        if (parts.length) arts = `<div class="dec-section"><div class="dec-label">Artifacts</div><ul>${parts.join("")}</ul></div>`;
      } catch {}
    }
    const mined = d.mined ? ` <span class="dec-mined" title="Auto-extracted, lower confidence">mined</span>` : "";
    body = `
      <div class="dec-detail">
        <div class="dec-section"><div class="dec-label">Chose</div><div>${esc(d.chose)}</div></div>
        <div class="dec-section"><div class="dec-label">Alternatives</div><ul>${alts}</ul></div>
        <div class="dec-section"><div class="dec-label">Why</div><div>${esc(d.why || "")}</div></div>
        ${cons}${cost}${arts}
        <div class="dec-meta">#${id} · ${esc(d.status)}${mined}</div>
      </div>`;
  }
  return `<div class="dec-row" data-did="${id}" ${indent}>
    <div class="dec-headline">
      <span class="dec-dot ${stClass}" title="${esc(d.status)}">${ic}</span>
      <div class="dec-title">${esc(d.summary)}</div>
      <div class="dec-when">${relativeTime(d.ts)}</div>
    </div>
    ${body}
  </div>`;
}

function _renderTimelineHtml(decisions){
  // Newest first feels more useful — recent forks are what you usually want to find.
  const sorted = [...decisions].sort((a,b) => (b.ts||0) - (a.ts||0));
  return sorted.map(d => _renderDecisionRow(d, 0)).join("");
}

function _renderTreeHtml(decisions){
  const byParent = new Map();
  for (const d of decisions) {
    const p = d.parent_id == null ? "ROOT" : String(d.parent_id);
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(d);
  }
  for (const arr of byParent.values()) arr.sort((a,b) => (a.ts||0) - (b.ts||0));
  const out = [];
  function walk(parentKey, depth) {
    const kids = byParent.get(parentKey) || [];
    for (const d of kids) {
      out.push(_renderDecisionRow(d, depth));
      walk(String(d.id), depth + 1);
    }
  }
  walk("ROOT", 0);
  // Orphans (parent_id points at a decision not in this list — e.g. project view with truncation)
  const known = new Set(decisions.map(d => String(d.id)));
  for (const d of decisions) {
    if (d.parent_id != null && !known.has(String(d.parent_id))) {
      // already handled above only if parent is missing AND we haven't rendered yet
    }
  }
  return out.join("") || '<div class="drawer-empty">No decisions to render</div>';
}

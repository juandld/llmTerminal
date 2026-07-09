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
      if (e.target.closest("a") || e.target.closest("button") || e.target.closest("input")) return;
      const id = row.dataset.did;
      if (_decisionsExpanded.has(id)) _decisionsExpanded.delete(id);
      else _decisionsExpanded.add(id);
      renderDecisions();
    });
  });
  // Wire answer buttons (innerHTML re-render drops listeners, so re-wire each pass)
  list.querySelectorAll("[data-answer-did]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const d = _decisions.find(x => String(x.id) === btn.dataset.answerDid);
      if (!d) return;
      const opts = _decAnswerOptions(d);
      _answerDecision(btn.dataset.answerDid, opts[Number(btn.dataset.answerIdx)] || "", btn);
    });
  });
  list.querySelectorAll("[data-answer-send]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.answerSend;
      const inp = list.querySelector(`[data-answer-input="${CSS.escape(id)}"]`);
      _answerDecision(id, (inp && inp.value) || "", btn);
    });
  });
  list.querySelectorAll("[data-answer-input]").forEach(inp => {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const id = inp.dataset.answerInput;
        const btn = list.querySelector(`[data-answer-send="${CSS.escape(id)}"]`);
        _answerDecision(id, inp.value, btn);
      }
    });
  });
}

function _decStatusClass(s){ return "dec-status-" + (s || "pending"); }
function _decStatusIcon(s){
  return s === "verified" ? "✓"
       : s === "reversed" ? "↺"
       : s === "answered" ? "✦"
       : s === "mined"    ? "~"
       : "•";
}

// A pending, explicitly-recorded decision (not auto-mined) is answerable by
// David from the drawer. The "ask David" convention: agents set
// chose = "ask David (proposed: <recommendation>)" with the options in
// alternatives — but any open fork can be answered/redirected.
const _DEC_ASK_RE = /^ask\s+(david|user|me)\b/i;
function _decIsAnswerable(d){ return !!d && !d.mined && d.status === "pending"; }
// If the decision's origin session != the currently viewed session, return
// {id,title} for the origin so the card can flag "answer will post to: X".
// Returns null when the card belongs to the chat you're already looking at.
function _decOriginChat(d){
  if (!d || !d.session_id) return null;
  if (typeof session === "undefined" || !session || d.session_id === session.id) return null;
  const s = (typeof _allSessions !== "undefined" && Array.isArray(_allSessions))
    ? _allSessions.find(x => x && x.id === d.session_id) : null;
  return { id: d.session_id, title: (s && s.title) || "(unknown chat)" };
}
function _decAnswerOptions(d){
  const opts = [];
  if (d.chose) {
    const m = d.chose.match(/\(proposed:?\s*([^)]+)\)/i);
    if (m && m[1].trim()) opts.push(m[1].trim());
    else if (!_DEC_ASK_RE.test(d.chose)) opts.push(d.chose);
  }
  if (Array.isArray(d.alternatives)) {
    for (const a of d.alternatives) { if (a && !opts.includes(a)) opts.push(a); }
  }
  return opts;
}

async function _answerDecision(id, answer, btn){
  answer = (answer || "").trim();
  if (!answer) return;
  const err = document.querySelector(`[data-answer-err="${id}"]`);
  if (err) err.textContent = "";
  if (btn) { btn.disabled = true; btn.dataset.prevText = btn.textContent; btn.textContent = "Sending…"; }
  try {
    const r = await fetch(apiUrl("/api/decisions/" + encodeURIComponent(id) + "/answer"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
    _decisionsExpanded.delete(String(id));
    await loadDecisions();
    refreshDecisionsBadge();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.prevText || "Retry"; }
    if (err) err.textContent = "⚠ " + (e.message || "failed");
  }
}

// Pending-answerable count on the topbar Decisions button (desktop + mobile
// overflow). Fetched per-project: same scope the drawer defaults to.
async function refreshDecisionsBadge(){
  try {
    if (!session || !session.project) return;
    const r = await fetch(apiUrl("/api/projects/" + encodeURIComponent(session.project) + "/decisions"));
    const data = await r.json();
    const n = (data.decisions || []).filter(_decIsAnswerable).length;
    for (const elId of ["decisionsBadge", "decisionsBadgeMobile"]) {
      const el = document.getElementById(elId);
      if (el) { el.textContent = String(n); el.style.display = n ? "" : "none"; }
    }
  } catch {}
}

function _renderDecisionRow(d, depth){
  const id = String(d.id);
  const expanded = _decisionsExpanded.has(id);
  const indent = depth ? `style="margin-left:${depth * 18}px"` : "";
  const stClass = _decStatusClass(d.status);
  const ic = _decStatusIcon(d.status);
  const answerable = _decIsAnswerable(d);
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
    const origin = _decOriginChat(d);
    let answerBlock = "";
    if (answerable) {
      const opts = _decAnswerOptions(d);
      const optBtns = opts.map((o, i) =>
        `<button class="dec-answer-btn" data-answer-did="${id}" data-answer-idx="${i}">${esc(o)}</button>`).join("");
      const answerLabel = origin
        ? `Answer posts to: <b>${esc(origin.title)}</b>`
        : "Your answer";
      const answerCls = origin ? "dec-answer dec-answer-foreign" : "dec-answer";
      answerBlock = `
        <div class="${answerCls}">
          <div class="dec-label">${answerLabel}</div>
          <div class="dec-answer-opts">${optBtns}</div>
          <div class="dec-answer-free">
            <input type="text" class="dec-answer-input" data-answer-input="${id}" placeholder="Or type your own…">
            <button class="dec-answer-send" data-answer-send="${id}">Send</button>
          </div>
          <div class="dec-answer-err" data-answer-err="${id}"></div>
        </div>`;
    }
    body = `
      <div class="dec-detail">
        <div class="dec-section"><div class="dec-label">Chose</div><div>${esc(d.chose)}</div></div>
        <div class="dec-section"><div class="dec-label">Alternatives</div><ul>${alts}</ul></div>
        <div class="dec-section"><div class="dec-label">Why</div><div>${esc(d.why || "")}</div></div>
        ${cons}${cost}${arts}
        ${answerBlock}
        <div class="dec-meta">#${id} · ${esc(d.status)}${mined}</div>
      </div>`;
  }
  const chip = answerable ? `<span class="dec-answer-chip">answer</span>` : "";
  const headlineOrigin = _decOriginChat(d);
  const originChip = headlineOrigin
    ? `<span class="dec-origin-chip" title="Origin chat: ${esc(headlineOrigin.title)} — answering here posts there, not in this chat">↪ ${esc(headlineOrigin.title)}</span>`
    : "";
  return `<div class="dec-row" data-did="${id}" ${indent}>
    <div class="dec-headline">
      <span class="dec-dot ${stClass}" title="${esc(d.status)}">${ic}</span>
      <div class="dec-title">${esc(d.summary)}</div>
      ${originChip}
      ${chip}
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

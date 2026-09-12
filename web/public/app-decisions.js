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
  // Fresh scope/view load: reset the strip's pan/zoom/range state — a stale
  // viewport pointing at the old dataset's time domain would be meaningless
  // once the underlying decisions (and their time range) change out from
  // under it.
  _stripViewport = null;
  _stripRange = null;
  try {
    const r = await fetch(url);
    const data = await r.json();
    _decisions = Array.isArray(data.decisions) ? data.decisions : [];
    _hasEarlierDecisions = !!data.hasMore;
  } catch (e) {
    _decisions = [];
    _hasEarlierDecisions = false;
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
  _renderDecisionsStrip();
  if (!_decisions.length) {
    list.innerHTML = '<div class="drawer-empty">No decisions recorded yet. Agents call <code>llmt_decide</code> to add them.</div>';
    return;
  }
  if (_decisionsView === "tree") {
    list.innerHTML = _renderTreeHtml(_decisions);
  } else {
    list.innerHTML = _renderTimelineHtml(_decisions);
    _stripApplyRangeFilter(); // re-apply an active range selection across re-renders
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
  list.querySelectorAll("[data-speak-did]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      _decSpeak(btn.dataset.speakDid);
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
    // Greedy up to the LAST ')' so recommendations containing nested parens
    // (e.g. "Yes (book Lufthansa RT (FCO-BKK))") aren't chopped, which used to
    // break dedup vs. d.alternatives and duplicate the recommendation as a button.
    const m = d.chose.match(/\(proposed:?\s*(.+)\)\s*$/i);
    if (m && m[1].trim()) opts.push(m[1].trim());
    else if (!_DEC_ASK_RE.test(d.chose)) opts.push(d.chose);
  }
  if (Array.isArray(d.alternatives)) {
    for (const a of d.alternatives) { if (a && !opts.includes(a)) opts.push(a); }
  }
  return opts;
}

// Spoken narration for a question card — synthesized from the fields that
// llmt_ask already carries. The tool's `context` argument becomes `d.why`,
// so a well-authored ask gives you a full "where we stopped / why it stopped
// / what you're deciding" paragraph for free. Falls back gracefully when the
// context is missing so the read-aloud is still usable, just terser.
function _decNarration(d){
  const parts = [];
  const q = (d.summary || "").trim();
  if (q) parts.push(q);

  const why = (d.why || "").trim();
  // Skip the generic default the MCP tool uses when the agent forgot `context`.
  if (why && !/^blocking question/i.test(why)) parts.push(why);

  // Prefer d.alternatives directly — that's the authoritative list the ask
  // tool sent. _decAnswerOptions folds the recommendation in for the UI, but
  // for narration a plain list is cleaner and avoids doubling the pick.
  const opts = Array.isArray(d.alternatives) && d.alternatives.length
    ? d.alternatives.map(a => (a || "").trim()).filter(Boolean)
    : _decAnswerOptions(d);
  if (opts.length) {
    const list = opts.map(o => o.replace(/\.$/, "")).join(". Or, ");
    parts.push("Your options are: " + list + ".");
  }
  return parts.join(" ");
}

function _decSpeak(id){
  const d = _decisions.find(x => String(x.id) === String(id));
  if (!d) return;
  const text = _decNarration(d);
  if (!text) return;
  try { playTts(text); } catch (e) { console.warn("[dec-speak] failed:", e); }
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
  if (expanded && answerable) {
    // Question card: no small-gray-text tree. Tap-anywhere-on-card lands you
    // here — a big "Read aloud" button (speaks the question + why + options)
    // and the tappable answer buttons. Everything else is one tap away in the
    // originating chat if David wants it; the drawer's job is to unblock.
    const opts = _decAnswerOptions(d);
    const optBtns = opts.map((o, i) =>
      `<button class="dec-answer-btn" data-answer-did="${id}" data-answer-idx="${i}">${esc(o)}</button>`).join("");
    const origin = _decOriginChat(d);
    const answerCls = origin ? "dec-answer dec-answer-foreign" : "dec-answer";
    const answerLabel = origin
      ? `<div class="dec-label">Answer posts to: <b>${esc(origin.title)}</b></div>`
      : "";
    body = `
      <div class="dec-detail dec-detail-question">
        <button class="dec-speak-btn" data-speak-did="${id}" aria-label="Read the question aloud">
          <span class="dec-speak-icon" aria-hidden="true">🔊</span>
          <span class="dec-speak-label">Read the question aloud</span>
        </button>
        <div class="${answerCls}">
          ${answerLabel}
          <div class="dec-answer-opts">${optBtns}</div>
          <div class="dec-answer-free">
            <input type="text" class="dec-answer-input" data-answer-input="${id}" placeholder="Or type your own…">
            <button class="dec-answer-send" data-answer-send="${id}">Send</button>
          </div>
          <div class="dec-answer-err" data-answer-err="${id}"></div>
        </div>
      </div>`;
  } else if (expanded) {
    // Non-answerable (verified / reversed / mined): the small-gray-text tree
    // is the whole point here — it's the audit trail. Keep it.
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

// Compact horizontal overview strip above the vertical list — adapted from
// dsh's TrajectoryTimeline (see styles.css for the full provenance note).
// Full port: real proportional-time span positioning, drag-to-select a
// range (spotlight-dims the vertical list to that range), wheel-zoom
// anchored at the cursor, edge-pan while dragging near the track edges,
// right-click-drag to pan, hover line, Escape/double-click to reset, and a
// lazy-loaded earlier-history boundary. Only shown in "timeline" view;
// hidden entirely in "tree" view (branching doesn't map onto a flat strip).
//
// State is module-level (not React) — geometry/interaction math is ported
// near-verbatim from TrajectoryTimeline.tsx (pure functions, provider-
// agnostic); re-rendering is manual instead of React's diffing. Two render
// tiers, same split dsh uses: _renderDecisionsStrip() rebuilds the span DOM
// (call when the DATASET changes — new load, earlier-history page, view
// switch); _updateStripTransform() only touches CSS custom properties on
// the already-built DOM (call on every pan/zoom/hover/drag/range change) —
// this is what keeps dragging smooth at 60fps instead of thrashing innerHTML.
let _stripModel = null;           // {start, end, spans:[{id, ts, status}]}
let _stripViewport = null;        // {start, end} | null (null = full domain)
let _stripRange = null;           // committed selection {start,end} | null
let _stripDraft = null;           // in-progress drag selection
let _stripHoverFraction = null;   // 0..1 | null
let _stripHoverId = null;
let _stripPanning = false;
let _stripAnimateViewport = false;
let _stripLoadingEarlier = false;
let _hasEarlierDecisions = false;
const _stripDrag = { active:false, pointerId:null, anchorTime:0, anchorClientX:0, recordId:null };
const _stripPan  = { active:false, pointerId:null, anchorClientX:0, anchorStart:0, moved:false, pannable:false };

const STRIP_MIN_DRAG_PX = 3;
const STRIP_EDGE_PAN_ZONE_FRACTION = 0.08;
const STRIP_EDGE_PAN_STEP_FRACTION = 0.025;
const STRIP_MAX_EDGE_PAN_PX = 24;

function _stripClampFraction(v){ return Math.min(1, Math.max(0, v)); }
function _stripOrderedRange(a, b){ return a <= b ? { start:a, end:b } : { start:b, end:a }; }
function _stripCenteredRange(center, width, min, max){
  const w = Math.min(max - min, Math.max(0, width));
  const start = Math.min(Math.max(center - w / 2, min), max - w);
  return { start, end: start + w };
}
function _stripRangeFraction(range, domainStart, domainDuration, min, max){
  const bounded = _stripOrderedRange(
    Math.min(max, Math.max(min, range.start)),
    Math.min(max, Math.max(min, range.end)),
  );
  return {
    start: (bounded.start - domainStart) / domainDuration,
    end: (bounded.end - domainStart) / domainDuration,
  };
}

function _deriveStripModel(decisions){
  if (!decisions.length) return null;
  const sorted = [...decisions].sort((a,b) => (a.ts||0) - (b.ts||0));
  const start = sorted[0].ts || 0;
  const end = Math.max(start + 1, sorted[sorted.length - 1].ts || start + 1);
  return { start, end, spans: sorted.map(d => ({ id: String(d.id), ts: d.ts || start, status: d.status || "pending", summary: d.summary || "" })) };
}

function _stripFullDuration(){ return Math.max(1, (_stripModel?.end ?? 0) - (_stripModel?.start ?? 0)); }
function _stripMinViewportDuration(){
  const full = _stripFullDuration();
  const n = _stripModel?.spans.length || 1;
  return Math.min(full, Math.max(5000, full / (n * 3)));
}
function _stripDomainStart(){
  if (!_stripModel) return 0;
  if (!_stripViewport) return _stripModel.start;
  const dur = _stripViewportDuration();
  return Math.min(Math.max(_stripViewport.start, _stripModel.start), _stripModel.end - dur);
}
function _stripViewportDuration(){
  const full = _stripFullDuration();
  if (!_stripViewport) return full;
  return Math.min(full, Math.max(1, _stripViewport.end - _stripViewport.start));
}
function _stripDomainDuration(){ return _stripViewport === null ? _stripFullDuration() : _stripViewportDuration(); }

// Tier 1: full rebuild — call when the DATASET or view changes.
function _renderDecisionsStrip(){
  const wrap  = document.getElementById("decisionsStripWrap");
  const track = document.getElementById("decisionsStripTrack");
  if (!wrap || !track) return;
  if (_decisionsView !== "timeline" || !_decisions.length) {
    wrap.style.display = "none";
    track.innerHTML = "";
    _stripModel = null;
    return;
  }
  wrap.style.display = "";
  _stripModel = _deriveStripModel(_decisions);
  // Viewport/range may reference a domain that no longer exists (e.g. after
  // an earlier-history load shifts model.start) — clear if now out of bounds.
  if (_stripViewport && (_stripViewport.end < _stripModel.start || _stripViewport.start > _stripModel.end)) _stripViewport = null;
  if (_stripRange && (_stripRange.end < _stripModel.start || _stripRange.start > _stripModel.end)) _stripRange = null;

  const full = _stripFullDuration();
  const spansHtml = _stripModel.spans.map(s => {
    const leftFrac = (s.ts - _stripModel.start) / full;
    const widthPx = 8; // fixed visual width; position is time-proportional, width is not (matches dsh's span min-width floor)
    const title = s.summary + " — " + s.status + (s.ts ? (" · " + relativeTime(s.ts)) : "");
    return `<span class="dec-strip-span" data-status="${esc(s.status)}" data-did="${esc(s.id)}"
      style="--dss-left:calc(${leftFrac * 100}% - ${widthPx/2}px);--dss-width:${widthPx}px" title="${esc(title)}"></span>`;
  }).join("");
  track.innerHTML =
    `<div class="dec-strip-lanes" id="decisionsStripLanes">${spansHtml}</div>` +
    `<div class="dec-strip-selection" id="decisionsStripSelection" hidden></div>` +
    `<div class="dec-strip-hover-line" id="decisionsStripHoverLine" hidden></div>` +
    `<button type="button" class="dec-strip-earlier" id="decisionsStripEarlier" hidden title="Load earlier history">…</button>`;

  track.querySelectorAll(".dec-strip-span").forEach(span => {
    span.addEventListener("click", (e) => {
      // Span clicks are handled by the track's own pointerup click-detection
      // (so drag-vs-click on a span works correctly); stop propagation only
      // to prevent the native <span> click from double-firing jump logic —
      // actual jump happens in _stripOnPointerUp.
      e.stopPropagation();
    });
  });

  _stripWireTrackOnce(track);
  const earlierBtn = document.getElementById("decisionsStripEarlier");
  if (earlierBtn) {
    earlierBtn.onclick = (e) => { e.stopPropagation(); _stripLoadEarlier(); };
  }
  _updateStripTransform();
}

// Tier 2: cheap update — call on pan/zoom/hover/drag/range change. Only
// touches CSS custom properties + a few data-attributes; never rebuilds
// the span DOM (that's what keeps interaction smooth).
function _updateStripTransform(){
  const lanes = document.getElementById("decisionsStripLanes");
  const selection = document.getElementById("decisionsStripSelection");
  const hoverLine = document.getElementById("decisionsStripHoverLine");
  const earlierBtn = document.getElementById("decisionsStripEarlier");
  const track = document.getElementById("decisionsStripTrack");
  if (!lanes || !_stripModel) return;

  const full = _stripFullDuration();
  const domainStart = _stripDomainStart();
  const domainDuration = _stripDomainDuration();
  lanes.style.setProperty("--dsl", `${-(domainStart - _stripModel.start) / domainDuration * 100}%`);
  lanes.style.setProperty("--dsw", `${full / domainDuration * 100}%`);
  lanes.dataset.animate = _stripAnimateViewport ? "true" : "false";

  const activeRange = _stripDraft ?? _stripRange;
  if (selection) {
    if (activeRange) {
      const frac = _stripRangeFraction(activeRange, domainStart, domainDuration, _stripModel.start, _stripModel.end);
      selection.style.setProperty("--dss-sel-left", `${frac.start * 100}%`);
      selection.style.setProperty("--dss-sel-width", `${Math.max(0, frac.end - frac.start) * 100}%`);
      selection.hidden = false;
    } else {
      selection.hidden = true;
    }
  }
  if (hoverLine) {
    if (_stripHoverFraction !== null && _stripDraft === null) {
      hoverLine.style.setProperty("--dss-hover-left", `${_stripHoverFraction * 100}%`);
      hoverLine.hidden = false;
    } else {
      hoverLine.hidden = true;
    }
  }
  if (earlierBtn) {
    const showEarlier = _hasEarlierDecisions && domainStart === _stripModel.start;
    earlierBtn.hidden = !showEarlier;
    earlierBtn.dataset.loading = _stripLoadingEarlier ? "true" : "false";
  }
  if (track) track.dataset.panning = _stripPanning ? "true" : "false";

  // Span hover/current/selected data-attrs (cheap — attribute writes, not
  // innerHTML rebuild). Selected = overlaps the active range when one exists.
  document.querySelectorAll("#decisionsStripLanes .dec-strip-span").forEach(span => {
    const id = span.dataset.did;
    span.dataset.hovered = (_stripHoverId === id) ? "true" : "false";
    if (activeRange) {
      const s = _stripModel.spans.find(x => x.id === id);
      span.dataset.selected = (s && s.ts >= activeRange.start && s.ts <= activeRange.end) ? "true" : "false";
    } else {
      span.removeAttribute("data-selected");
    }
  });
}

// Wire pointer/wheel/keyboard listeners ONCE per track element (survives
// across Tier-2 updates since those never touch the track node itself;
// re-wired only when Tier 1 rebuilds — guarded via a dataset flag so a
// same-element rebuild-in-place doesn't double-bind).
function _stripWireTrackOnce(track){
  if (track.dataset.stripWired === "true") return;
  track.dataset.stripWired = "true";
  track.tabIndex = 0;
  track.setAttribute("aria-label", "Decisions timeline overview; drag horizontally to select a range");

  const fractionAt = (e) => {
    const rect = track.getBoundingClientRect();
    return _stripClampFraction((e.clientX - rect.left) / Math.max(1, rect.width));
  };
  const idAt = (e) => {
    const el = e.target instanceof HTMLElement ? e.target.closest("[data-did]") : null;
    return el ? el.dataset.did : null;
  };

  track.addEventListener("pointerdown", (e) => {
    if (!_stripModel) return;
    if (e.button === 2) {
      _stripPan.active = true;
      _stripPan.pointerId = e.pointerId;
      _stripPan.anchorClientX = e.clientX;
      _stripPan.anchorStart = _stripDomainStart();
      _stripPan.moved = false;
      _stripPan.pannable = _stripViewport !== null;
      if (_stripViewport !== null) _stripAnimateViewport = false;
      _stripPanning = true;
      try { track.setPointerCapture(e.pointerId); } catch {}
      _updateStripTransform();
      return;
    }
    if (e.button !== 0) return;
    const frac = fractionAt(e);
    const anchorTime = _stripDomainStart() + frac * _stripDomainDuration();
    const recordId = idAt(e);
    _stripHoverFraction = frac;
    _stripHoverId = recordId;
    _stripDrag.active = true;
    _stripDrag.pointerId = e.pointerId;
    _stripDrag.anchorTime = anchorTime;
    _stripDrag.anchorClientX = e.clientX;
    _stripDrag.recordId = recordId;
    try { track.setPointerCapture(e.pointerId); } catch {}
    _stripDraft = { start: anchorTime, end: anchorTime };
    _updateStripTransform();
  });

  track.addEventListener("pointermove", (e) => {
    if (!_stripModel) return;
    const rect = track.getBoundingClientRect();
    const frac = fractionAt(e);
    _stripHoverFraction = frac;
    _stripHoverId = idAt(e);

    if (_stripPan.active && _stripPan.pointerId === e.pointerId) {
      if (Math.abs(e.clientX - _stripPan.anchorClientX) >= STRIP_MIN_DRAG_PX) _stripPan.moved = true;
      if (_stripPan.pannable) {
        const domainDuration = _stripDomainDuration();
        const delta = (e.clientX - _stripPan.anchorClientX) / Math.max(1, rect.width);
        const nextStart = Math.min(
          Math.max(_stripPan.anchorStart - delta * domainDuration, _stripModel.start),
          _stripModel.end - domainDuration,
        );
        _stripViewport = { start: nextStart, end: nextStart + domainDuration };
      }
      _updateStripTransform();
      return;
    }

    if (_stripDrag.active && _stripDrag.pointerId === e.pointerId) {
      let domainStart = _stripDomainStart();
      const domainDuration = _stripDomainDuration();
      if (_stripViewport !== null) {
        const localX = e.clientX - rect.left;
        const edgeWidth = Math.min(STRIP_MAX_EDGE_PAN_PX, Math.max(1, rect.width * STRIP_EDGE_PAN_ZONE_FRACTION));
        const direction = localX < edgeWidth ? -1 : (localX > rect.width - edgeWidth ? 1 : 0);
        if (direction !== 0) {
          const edgeDistance = direction < 0 ? edgeWidth - localX : localX - (rect.width - edgeWidth);
          const strength = _stripClampFraction(edgeDistance / edgeWidth);
          const desired = domainStart + direction * domainDuration * STRIP_EDGE_PAN_STEP_FRACTION * Math.max(0.2, strength);
          const nextStart = Math.min(Math.max(desired, _stripModel.start), _stripModel.end - domainDuration);
          if (nextStart !== domainStart) {
            _stripAnimateViewport = false;
            _stripViewport = { start: nextStart, end: nextStart + domainDuration };
            domainStart = nextStart;
          }
        }
      }
      const pointTime = domainStart + frac * domainDuration;
      _stripDraft = _stripOrderedRange(_stripDrag.anchorTime, pointTime);
    }
    _updateStripTransform();
  });

  const endPointer = (e) => {
    if (_stripPan.active && _stripPan.pointerId === e.pointerId) {
      const moved = _stripPan.moved || Math.abs(e.clientX - _stripPan.anchorClientX) >= STRIP_MIN_DRAG_PX;
      _stripPan.active = false;
      _stripPanning = false;
      if (!moved) { _stripRange = null; _stripApplyRangeFilter(); }
      _updateStripTransform();
      return;
    }
    if (!_stripDrag.active || _stripDrag.pointerId !== e.pointerId) return;
    const frac = fractionAt(e);
    const pointTime = _stripDomainStart() + frac * _stripDomainDuration();
    const selected = _stripOrderedRange(_stripDrag.anchorTime, pointTime);
    _stripHoverFraction = frac;
    _stripHoverId = idAt(e);
    _stripDrag.active = false;
    const isClick = Math.abs(e.clientX - _stripDrag.anchorClientX) < STRIP_MIN_DRAG_PX;
    _stripDraft = null;

    if (isClick && _stripDrag.recordId !== null) {
      // Simple click on a span → jump to it in the vertical list, don't commit a range.
      _stripRange = null;
      _updateStripTransform();
      _stripApplyRangeFilter();
      _jumpToDecision(_stripDrag.recordId);
      return;
    }
    const minDur = _stripMinViewportDuration();
    const committed = (selected.end - selected.start) < minDur
      ? _stripCenteredRange(isClick ? selected.start : (selected.start + selected.end) / 2, minDur, _stripModel.start, _stripModel.end)
      : selected;
    _stripRange = committed;
    _updateStripTransform();
    _stripApplyRangeFilter();
  };
  track.addEventListener("pointerup", endPointer);
  track.addEventListener("pointercancel", () => {
    _stripDrag.active = false;
    _stripPan.active = false;
    _stripDraft = null;
    _stripHoverFraction = null;
    _stripHoverId = null;
    _stripPanning = false;
    _updateStripTransform();
  });
  track.addEventListener("pointerleave", () => {
    if (!_stripDrag.active && !_stripPan.active) {
      _stripHoverFraction = null;
      _stripHoverId = null;
      _updateStripTransform();
    }
  });
  track.addEventListener("dblclick", (e) => {
    e.preventDefault();
    _stripViewport = null;
    _stripRange = null;
    _updateStripTransform();
    _stripApplyRangeFilter();
  });
  track.addEventListener("contextmenu", (e) => { e.preventDefault(); });
  track.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || _stripRange === null) return;
    e.preventDefault();
    _stripRange = null;
    _updateStripTransform();
    _stripApplyRangeFilter();
  });
  track.addEventListener("wheel", (e) => {
    if (!_stripModel) return;
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    const anchorFraction = _stripClampFraction((e.clientX - rect.left) / Math.max(1, rect.width));
    const full = _stripFullDuration();
    const domainStart = _stripDomainStart();
    const domainDuration = _stripDomainDuration();
    _stripAnimateViewport = false;
    const minDur = _stripMinViewportDuration();
    const nextDuration = Math.min(full, Math.max(minDur, domainDuration * Math.exp(e.deltaY * 0.0015)));
    if (nextDuration >= full * 0.999) {
      _stripViewport = null;
      _updateStripTransform();
      return;
    }
    const anchorTime = domainStart + anchorFraction * domainDuration;
    const nextStart = Math.min(Math.max(anchorTime - anchorFraction * nextDuration, _stripModel.start), _stripModel.end - nextDuration);
    _stripViewport = { start: nextStart, end: nextStart + nextDuration };
    _updateStripTransform();
  }, { passive: false });
}

// Filter the vertical list to the committed range selection (or show
// everything when there's no active range). Shows a "N of M — Clear" banner
// so the filtered state is never silently confusing.
function _stripApplyRangeFilter(){
  const list = document.getElementById("decisionsList");
  if (!list) return;
  let banner = document.getElementById("decisionsRangeBanner");
  if (_stripRange === null) {
    list.querySelectorAll(".dec-row.dec-row-range-hidden").forEach(r => r.classList.remove("dec-row-range-hidden"));
    if (banner) banner.remove();
    return;
  }
  const rows = list.querySelectorAll(".dec-row");
  let shown = 0;
  rows.forEach(row => {
    const d = _decisions.find(x => String(x.id) === row.dataset.did);
    const inRange = d && d.ts >= _stripRange.start && d.ts <= _stripRange.end;
    row.classList.toggle("dec-row-range-hidden", !inRange);
    if (inRange) shown++;
  });
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "decisionsRangeBanner";
    banner.className = "dec-strip-range-banner";
    list.prepend(banner);
  } else {
    list.prepend(banner); // keep pinned at top after re-renders
  }
  banner.innerHTML = `<span>${shown} of ${_decisions.length} shown (range selected)</span><button type="button">Clear</button>`;
  banner.querySelector("button").onclick = () => {
    _stripRange = null;
    _updateStripTransform();
    _stripApplyRangeFilter();
  };
}

// Fetch one earlier page and prepend. Mirrors dsh's earlier-history
// boundary — a small "…" button that appears only when the domain's left
// edge is at the start of what's currently loaded AND the server says
// there's more (hasMore from the last load).
async function _stripLoadEarlier(){
  if (_stripLoadingEarlier || !_hasEarlierDecisions || !_decisions.length) return;
  _stripLoadingEarlier = true;
  _updateStripTransform();
  try {
    const oldestTs = Math.min(..._decisions.map(d => d.ts || Infinity));
    let url;
    if (_decisionsScope === "project") {
      url = apiUrl("/api/projects/" + encodeURIComponent(session.project) + "/decisions?before=" + oldestTs);
    } else {
      url = apiUrl("/api/sessions/" + session.id + "/decisions?before=" + oldestTs);
    }
    const r = await fetch(url);
    const data = await r.json();
    const earlier = Array.isArray(data.decisions) ? data.decisions : [];
    _hasEarlierDecisions = !!data.hasMore;
    if (earlier.length) {
      const known = new Set(_decisions.map(d => String(d.id)));
      _decisions = [...earlier.filter(d => !known.has(String(d.id))), ..._decisions];
    }
  } catch (e) {
    console.warn("[decisions] load earlier failed:", e.message);
  } finally {
    _stripLoadingEarlier = false;
    renderDecisions();
  }
}

// Click a strip span → expand + scroll to + flash the matching row in the
// vertical list below (bridges the new overview into the existing detail
// view rather than duplicating it).
function _jumpToDecision(id){
  if (!id) return;
  _decisionsExpanded.add(String(id));
  renderDecisions();
  requestAnimationFrame(() => {
    const row = document.querySelector('#decisionsList .dec-row[data-did="' + CSS.escape(String(id)) + '"]');
    if (!row) return;
    row.classList.remove("dec-row-range-hidden");
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("dec-row-flash");
    void row.offsetWidth; // restart animation if already flashed once
    row.classList.add("dec-row-flash");
  });
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

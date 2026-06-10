// Model/effort picker UI for llmTerminal — classic script, shares global
// scope with app.js (loaded after it). Extracted (refactor 2026-06-10, app.js phase 1).

function _findModelMeta(id) {
  if (!_allModelsData) return null;
  for (const prov of ["claude", "openai", "google"]) {
    const m = (_allModelsData[prov] || []).find(x => x.id === id);
    if (m) return { ...m, provider: prov };
  }
  return null;
}

function _displayName(id) {
  // An empty/null id means the session runs on the CLI default, which is Opus.
  // Resolve it to the real model so the picker shows concrete intel ("Opus 4.8")
  // instead of an opaque "Default".
  const realId = id || "opus";
  const m = _findModelMeta(realId);
  return m ? m.name : realId;
}

function _syncLabels(id) {
  const eff = localStorage.getItem("llmt_effort") || "max";
  // Always show the effort level (including "max") so the label is full intel:
  // "Opus 4.8 · max", never just a bare model name or "Default".
  const name = _displayName(id) + " · " + (eff === "medium" ? "med" : eff);
  const meta = _findModelMeta(id);
  const provider = meta?.provider || "claude";
  const desktop = modelPickLabel(); if (desktop) desktop.textContent = name;
  const mobile  = omModelPickLabel(); if (mobile)  mobile.textContent  = name;
  for (const btn of [document.getElementById("modelPickerBtn"), document.getElementById("omModelPickerBtn")]) {
    if (btn) {
      btn.classList.toggle("dirty", !!id && id !== "opus");
      btn.setAttribute("data-provider", provider);
      btn.title = provider === "claude"
        ? "Model for this session"
        : provider.toUpperCase() + ": chat fallback (tools not wired yet). Use Claude for filesystem/browser/email.";
    }
  }
}

function renderModelMenu() {
  const list = document.getElementById("modelPickerList");
  if (!list || !_allModelsData) return;
  const selected = (localStorage.getItem("llmt_default_model") || "opus");
  list.innerHTML = "";

  // ── Effort selector (low / medium / high / max) ──
  const curEffort = localStorage.getItem("llmt_effort") || "max";
  const effRow = mk("div", "mp-effort-row");
  const effLabel = mk("span", "mp-effort-label"); effLabel.textContent = "Effort";
  effRow.appendChild(effLabel);
  const effSeg = mk("div", "mp-effort-seg");
  for (const lvl of ["low", "medium", "high", "max"]) {
    const b = mk("button", "mp-effort-btn" + (lvl === curEffort ? " active" : ""));
    b.type = "button";
    b.dataset.effort = lvl;
    b.textContent = lvl === "medium" ? "med" : lvl;
    b.addEventListener("click", (e) => { e.stopPropagation(); selectEffort(lvl); });
    effSeg.appendChild(b);
  }
  effRow.appendChild(effSeg);
  list.appendChild(effRow);
  const provs = [
    { key: "claude", label: "Claude (full tools)" },
    { key: "openai", label: "OpenAI (chat)" },
    { key: "google", label: "Google (chat)" },
  ];
  for (const { key, label } of provs) {
    const models = _allModelsData[key] || [];
    const prov = document.createElement("div");
    prov.className = "win95-prov";
    prov.dataset.expanded = String(_provExpanded[key]);
    prov.dataset.key = key;
    const arrow = document.createElement("span"); arrow.className = "win95-prov-arrow";
    const labelEl = document.createElement("span"); labelEl.textContent = label + (models.length ? "" : " — no key");
    prov.appendChild(arrow); prov.appendChild(labelEl);
    const items = document.createElement("div");
    items.className = "win95-prov-items";
    items.hidden = !_provExpanded[key];
    // For non-Claude providers, prepend an honest one-liner explaining what
    // they're useful for right now (chat-only fallback for when Claude rate-
    // limits) and that real tool parity is in flight.
    if (key === "openai" || key === "google") {
      const note = document.createElement("div");
      note.className = "win95-fallback-note";
      note.textContent = "Chat-only fallback for when Claude is rate-limited. Tool support is in development.";
      items.appendChild(note);
    }
    if (!models.length) {
      const e = document.createElement("div"); e.className = "win95-empty"; e.textContent = "(add " + key.toUpperCase() + "_API_KEY to enable)";
      items.appendChild(e);
    }
    models.forEach((m, idx) => {
      const el = document.createElement("div");
      el.className = "win95-model" + (m.id === selected ? " selected" : "");
      el.dataset.id = m.id;
      el.tabIndex = 0;
      const star = document.createElement("span"); star.className = "win95-model-star";
      star.textContent = idx === 0 ? "★" : "";
      star.title = idx === 0 ? "Smartest in " + label : "";
      const name = document.createElement("span"); name.textContent = m.name;
      el.appendChild(star); el.appendChild(name);
      el.addEventListener("click", (e) => { e.stopPropagation(); selectModel(m.id); });
      items.appendChild(el);
    });
    prov.addEventListener("click", () => {
      _provExpanded[key] = !_provExpanded[key];
      prov.dataset.expanded = String(_provExpanded[key]);
      items.hidden = !_provExpanded[key];
    });
    list.appendChild(prov);
    list.appendChild(items);
  }
}

// Visibility uses .mp-open class (NOT the [hidden] attribute) so we sidestep
// any UA-stylesheet quirks AND so mobile browsers reliably dispatch events to
// covered elements. Close handlers are bound via JS (no inline onclick) and
// listen to BOTH `click` and `pointerdown` so finger-taps that get swallowed
// by Safari's touch heuristics still close the menu.
function _mpIsOpen() {
  const menu = document.getElementById("modelPickerMenu");
  return menu && menu.classList.contains("mp-open");
}

function toggleModelMenu(evt) {
  if (evt && evt.stopPropagation) evt.stopPropagation();
  if (evt && evt.preventDefault) evt.preventDefault();
  if (_mpIsOpen()) { hideModelMenu(); return; }
  showModelMenu(evt);
}

function showModelMenu(evt) {
  const menu = document.getElementById("modelPickerMenu");
  const backdrop = document.getElementById("modelPickerBackdrop");
  if (!menu || !backdrop) return;
  const _curId = localStorage.getItem("llmt_default_model") || "opus";
  const _meta = _findModelMeta(_curId);
  const _curProv = _meta?.provider || "claude";
  for (const k of Object.keys(_provExpanded)) _provExpanded[k] = (k === _curProv);
  renderModelMenu();
  const trigger = evt?.currentTarget;
  if (window.innerWidth > 768 && trigger && trigger.getBoundingClientRect) {
    const r = trigger.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + "px";
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 340)) + "px";
    menu.style.right = "";
  } else {
    menu.style.top = "10vh";
    menu.style.left = "";
    menu.style.right = "";
  }
  menu.classList.add("mp-open");
  backdrop.classList.add("mp-open");
  // Belt + suspenders: also clear the legacy `hidden` attribute, since older
  // versions of this file used it.
  menu.hidden = false;
  backdrop.hidden = false;
  for (const btn of [document.getElementById("modelPickerBtn"), document.getElementById("omModelPickerBtn")]) {
    if (btn) btn.setAttribute("aria-expanded", "true");
  }
}

function hideModelMenu(reason) {
  const menu = document.getElementById("modelPickerMenu");
  const backdrop = document.getElementById("modelPickerBackdrop");
  if (menu) { menu.classList.remove("mp-open"); menu.hidden = true; }
  if (backdrop) { backdrop.classList.remove("mp-open"); backdrop.hidden = true; }
  for (const btn of [document.getElementById("modelPickerBtn"), document.getElementById("omModelPickerBtn")]) {
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  if (reason) console.log("[picker] hide:", reason);
}

// Bind close handlers AS SOON AS the DOM is ready (or immediately if it
// already is). Listen to both click + pointerdown to survive Safari touch
// quirks. The trigger buttons keep their own inline onclick="toggleModelMenu".
function _bindPickerCloseHandlers() {
  const x = document.querySelector("#modelPickerMenu .win95-x");
  if (x && !x._mpBound) {
    x._mpBound = true;
    const closeFromX = (e) => { e.preventDefault(); e.stopPropagation(); hideModelMenu("X-button"); };
    x.addEventListener("click", closeFromX);
    x.addEventListener("pointerdown", closeFromX);
  }
  const bd = document.getElementById("modelPickerBackdrop");
  if (bd && !bd._mpBound) {
    bd._mpBound = true;
    const closeFromBd = (e) => { e.stopPropagation(); hideModelMenu("backdrop"); };
    bd.addEventListener("click", closeFromBd);
    bd.addEventListener("pointerdown", closeFromBd);
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _bindPickerCloseHandlers);
} else {
  _bindPickerCloseHandlers();
}
// Document-level catch-all: any pointerdown outside the menu and outside the
// triggers closes the menu. Capture phase so we run before any inner handler
// that might stopPropagation.
function _docCloseHandler(e) {
  if (!_mpIsOpen()) return;
  const t = e.target;
  const menu = document.getElementById("modelPickerMenu");
  if (menu && menu.contains(t)) return;
  if (t.closest && (t.closest("#modelPickerBtn") || t.closest("#omModelPickerBtn"))) return;
  hideModelMenu("outside-pointer");
}
document.addEventListener("pointerdown", _docCloseHandler, true);
document.addEventListener("click", _docCloseHandler, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideModelMenu("escape-key"); });

function selectEffort(level) {
  try { localStorage.setItem("llmt_effort", level); } catch {}
  if (typeof ws !== "undefined" && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "set_effort", effort: level }));
  }
  // Update the active state in the open menu without a full re-render
  document.querySelectorAll("#modelPickerMenu .mp-effort-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.effort === level);
  });
  _syncLabels(localStorage.getItem("llmt_default_model") || "opus");
}

function selectModel(id) {
  try { localStorage.setItem("llmt_default_model", id); } catch {}
  _syncLabels(id);
  if (typeof ws !== "undefined" && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "set_model", model: id }));
  }
  // mark in menu DOM
  document.querySelectorAll("#modelPickerMenu .win95-model").forEach(el => {
    el.classList.toggle("selected", el.dataset.id === id);
  });
  hideModelMenu();
}

(async function loadModels() {
  try {
    const r = await fetch(apiUrl("/api/models"));
    if (!r.ok) {
      console.warn("[models] load failed: HTTP", r.status, "from", apiUrl("/api/models"));
      return;
    }
    _allModelsData = await r.json();
    let saved = "";
    try { saved = localStorage.getItem("llmt_default_model") || ""; } catch {}
    if (!saved) {
      saved = "opus";
      try { localStorage.setItem("llmt_default_model", saved); } catch {}
    }
    _syncLabels(saved);
    // Push persisted effort to the server so the session honors it from msg 1.
    try {
      const eff = localStorage.getItem("llmt_effort") || "max";
      const _send = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "set_effort", effort: eff })); };
      if (typeof ws !== "undefined" && ws && ws.readyState === 1) _send();
      else setTimeout(_send, 1500);
    } catch {}
  } catch (e) { console.warn("[models] load failed:", e.message); }
})();

// Exposed so the legacy WS "model_set" event handler keeps working
window.toggleModelMenu = toggleModelMenu;
window.hideModelMenu = hideModelMenu;
window.selectModel = selectModel;
// Compat shims: code below still references these names. Keep them as no-op stubs
// that just sync the label, since the real source-of-truth is localStorage + WS.
const modelSel = { get value(){ return localStorage.getItem("llmt_default_model") || ""; },
                   set value(v){ try { localStorage.setItem("llmt_default_model", v); } catch {}; _syncLabels(v); },
                   classList: { toggle(){}, add(){}, remove(){} },
                   dispatchEvent(){},
                   addEventListener(){} };
function applyModelDirty() { _syncLabels(localStorage.getItem("llmt_default_model") || ""); }
function toggleAllModels() { /* removed — all models always visible */ }

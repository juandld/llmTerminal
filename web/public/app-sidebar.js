// Sidebar / session-list rendering for llmTerminal — classic script, shares
// global scope with app.js. Extracted (refactor 2026-06-10, app.js phase 2).

function makeSbItem(x, currentProject) {
  const d = document.createElement("div");
  // 5-state triage class
  const state = computeSessionState(x);
  const stateClass = state ? "state-" + state : "";
  d.className = "sb-item " + stateClass + (session?.id === x.id ? " active" : "") + (x.archived ? " sb-archived" : "");
  d.dataset.state = state;
  const ti = mk("div", "ti");
  const row1 = mk("div", "row1");
  if (state && STATE_ICONS[state]) {
    const ic = mk("span", "sb-ic sb-ic-" + state);
    ic.textContent = STATE_ICONS[state];
    row1.appendChild(ic);
  }
  const ttl = mk("div", "ttl"); ttl.textContent = x.title || "(untitled)";
  row1.appendChild(ttl);
  ti.appendChild(row1);
  const row2 = mk("div", "row2");
  if (currentProject === "ALL" && x.project) {
    const pj = mk("span", "pj"); pj.textContent = x.project; row2.appendChild(pj);
  }
  const when = mk("span", ""); when.textContent = relativeTime(x.lastActive);
  row2.appendChild(when);
  if (x.messageCount) {
    const mc = mk("span", ""); mc.textContent = "\u00b7 " + x.messageCount + " msg"; row2.appendChild(mc);
  }
  ti.appendChild(row2);
  // Activity snippet — what's happening in this chat
  if (x.lastSnippet) {
    const snip = mk("div", "sb-snippet");
    snip.textContent = x.lastSnippet;
    ti.appendChild(snip);
  }
  d.appendChild(ti);
  // Priority badge — small right-aligned score, tap → breakdown popover.
  // Star indicator shows when x.starred is true (manual ROI floor).
  if (typeof x.priority_score === "number") {
    const pb = mk("div", "sb-prio");
    if (x.starred) {
      const star = mk("span", "sb-prio-star");
      star.textContent = "★";
      pb.appendChild(star);
    }
    const num = mk("span", "sb-prio-num");
    num.textContent = String(x.priority_score);
    pb.appendChild(num);
    pb.title = "Priority: " + x.priority_score + " (tap for breakdown)";
    pb.onclick = (e) => { e.stopPropagation(); showPriorityBreakdown(x, pb); };
    d.appendChild(pb);
  }
  // \u2713 button: mark a "responded" or "stalled" session done without further fuss.
  // Hidden for blocked/decision/working/done (those need real action, not dismissal).
  if (state === "responded" || state === "stalled") {
    const okb = mk("button", "sb-done-btn"); okb.textContent = "\u2713";
    okb.title = state === "stalled" ? "Dismiss (claude process exited without responding)" : "Mark done";
    okb.onclick = (e) => { e.stopPropagation(); markSessionDone(x.id); };
    d.appendChild(okb);
  }
  const xb = mk("button", "x"); xb.textContent = "\u00d7";
  d.appendChild(xb);
  ti.onclick = () => resumeSession(x);
  xb.onclick = (e) => { e.stopPropagation(); delSession(x.id); };
  let pressTimer = null;
  d.addEventListener("touchstart", (e) => {
    pressTimer = setTimeout(() => { showSessionInfo(x, d); pressTimer = null; }, 500);
  }, { passive: true });
  d.addEventListener("touchend", () => { if (pressTimer) clearTimeout(pressTimer); });
  d.addEventListener("touchmove", () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
  d.addEventListener("contextmenu", (e) => { e.preventDefault(); showSessionInfo(x, d); });
  d.title = (x.title || "") + "\n" + (x.project || "") + " \u00b7 " + (x.messageCount || 0) + " msgs \u00b7 " + relativeTime(x.lastActive) + (x.archived ? " \u00b7 archived" : "");
  return d;
}
function renderBucketed(items, parent, currentProject) {
  const buckets = {};
  items.forEach(x => { const b = recencyBucket(x.lastActive); (buckets[b] = buckets[b] || []).push(x); });
  BUCKET_ORDER.forEach(bname => {
    if (!buckets[bname]) return;
    const bh = mk("div", "sb-bucket"); bh.textContent = bname;
    parent.appendChild(bh);
    buckets[bname].forEach(x => parent.appendChild(makeSbItem(x, currentProject)));
  });
}
function renderProjectGroup(projectName, items, parent, forceExpand) {
  let collapsed = false;
  if (forceExpand) {
    collapsed = false;
  } else if (_collapsedProjects.has(projectName)) {
    collapsed = true;
  } else if (!_collapsedProjects.has("__expanded_" + projectName)) {
    const newestTs = Math.max(...items.map(x => x.lastActive || 0));
    collapsed = !RECENT_BUCKETS.has(recencyBucket(newestTs));
  }
  const header = mk("div", "sb-group" + (collapsed ? " collapsed" : ""));
  const left = mk("span", "gname");
  const chev = mk("span", "chev"); chev.textContent = "\u25BC";
  left.appendChild(chev);
  left.appendChild(document.createTextNode(" " + projectName));
  const count = mk("span", "gcount"); count.textContent = items.length ? String(items.length) : "\u2014";
  header.appendChild(left);
  header.appendChild(count);
  const content = mk("div", "sb-project-content");
  renderBucketed(items, content, "ALL");
  header.onclick = () => {
    const isNowCollapsed = !header.classList.contains("collapsed");
    header.classList.toggle("collapsed");
    if (isNowCollapsed) {
      _collapsedProjects.add(projectName);
      _collapsedProjects.delete("__expanded_" + projectName);
    } else {
      _collapsedProjects.delete(projectName);
      _collapsedProjects.add("__expanded_" + projectName);
    }
    _persistCollapsed();
    // Tapping a project header sets it as the active context — the
    // "+ New in X" button reflects this. Strip "(archived)" suffix the
    // archive renderer adds so the button gets a clean project name.
    const cleanProj = projectName.replace(/ \(archived\)$/, "");
    if (_availableProjects.includes(cleanProj)) {
      try { localStorage.setItem("llmt_project", cleanProj); } catch {}
      _updateNewSessionLabel();
    }
  };
  parent.appendChild(header);
  parent.appendChild(content);
}
async function loadSessions() {
  _allSessions = await fetch(apiUrl("/api/sessions?project=ALL")).then(r => r.json());
  // Re-apply optimistic updates that may have raced the fetch.
  _applyPendingToList(_allSessions);
  _renderSidebar();
}
function _renderSidebar() {
  _updateNewSessionLabel();
  sbList.innerHTML = "";
  const qRaw = (_searchQuery || "").trim();
  const q = qRaw.toLowerCase();
  const contentHit = (x) => _contentMatchIds && _contentMatchIds.has(x.id);
  const matches = (x) =>
    !q ||
    (x.title   || "").toLowerCase().includes(q) ||
    (x.project || "").toLowerCase().includes(q) ||
    (x.lastSnippet || "").toLowerCase().includes(q) ||
    contentHit(x);
  const filtered = _allSessions.filter(matches);
  const active = filtered.filter(x => !x.archived);
  const archived = filtered.filter(x => x.archived);
  if (!filtered.length && q) {
    const empty = mk("div", "sb-empty");
    const stillRunning = _contentMatchQuery !== qRaw;
    empty.textContent = stillRunning
      ? "Searching message bodies for \"" + qRaw + "\"…"
      : "No sessions match \"" + qRaw + "\"";
    sbList.appendChild(empty);
    return;
  }

  // Partition by state into three groups
  const attentionItems = [];  // blocked, decision — top section
  const progressItems  = [];  // responded, working — per-project groups
  const doneItems      = [];  // done — collapsed at bottom
  active.forEach(s => {
    const st = computeSessionState(s);
    if (st === "blocked" || st === "decision" || st === "stalled") attentionItems.push(s);
    else if (st === "done") doneItems.push(s);
    else progressItems.push(s);
  });

  // ─── Section 1: NEEDS YOU — sorted by priority_score (time × ROI), state
  // priority breaks ties when scores match, lastActive breaks ties after that.
  if (attentionItems.length) {
    attentionItems.sort((a, b) => {
      const pa = a.priority_score || 0, pb = b.priority_score || 0;
      if (pa !== pb) return pb - pa;
      const sa = computeSessionState(a), sb = computeSessionState(b);
      if (STATE_PRIORITY[sa] !== STATE_PRIORITY[sb]) return STATE_PRIORITY[sa] - STATE_PRIORITY[sb];
      return (b.lastActive || 0) - (a.lastActive || 0);
    });
    const h = mk("div", "sb-section-header sb-needs-you");
    h.textContent = "\u{1F6A8} NEEDS YOU (" + attentionItems.length + ")";
    sbList.appendChild(h);
    attentionItems.forEach(x => sbList.appendChild(makeSbItem(x, "ALL")));
    // Fire-and-forget: ask backend to Haiku-rescore the top items so future
    // refreshes use a value judgment, not just project base + keyword hits.
    try { triggerPriorityRescore(attentionItems.slice(0, 10).map(s => s.id)); } catch {}
  }

  // ─── Section 2: in-progress chats grouped by project ───
  // Sort within each group by priority_score desc so the most valuable
  // "responded" sessions surface first inside each bucket.
  const byProj = {};
  progressItems.forEach(x => { (byProj[x.project] = byProj[x.project] || []).push(x); });
  for (const k of Object.keys(byProj)) {
    byProj[k].sort((a, b) => {
      const pa = a.priority_score || 0, pb = b.priority_score || 0;
      if (pa !== pb) return pb - pa;
      return (b.lastActive || 0) - (a.lastActive || 0);
    });
  }
  const seedKeys = q ? Object.keys(byProj) : Array.from(new Set([..._availableProjects, ...Object.keys(byProj)]));
  const projOrder = seedKeys.sort((a, b) => {
    const aMax = Math.max(...((byProj[a] || []).map(x => x.lastActive || 0)), 0);
    const bMax = Math.max(...((byProj[b] || []).map(x => x.lastActive || 0)), 0);
    if (aMax !== bMax) return bMax - aMax;
    return a.localeCompare(b);
  });
  const forceExpand = !!q;
  projOrder.forEach(pname => renderProjectGroup(pname, byProj[pname] || [], sbList, forceExpand));

  // ─── Section 3: DONE (collapsed by default, with summary + bulk archive) ───
  if (doneItems.length) renderDoneSection(doneItems);

  // ─── Section 4: archived (existing behavior preserved) ───
  if (archived.length) {
    const toggle = mk("div", "sb-archive-toggle");
    toggle.textContent = (_showArchived ? "\u25BC Hide" : "\u25B6 Show") + " archived (" + archived.length + ")";
    toggle.onclick = () => { _showArchived = !_showArchived; _renderSidebar(); };
    sbList.appendChild(toggle);
    if (_showArchived) {
      const wrap = mk("div", "");
      const byProjA = {};
      archived.forEach(x => { (byProjA[x.project] = byProjA[x.project] || []).push(x); });
      Object.keys(byProjA).sort().forEach(p => renderProjectGroup(p + " (archived)", byProjA[p], wrap, forceExpand));
      sbList.appendChild(wrap);
    }
  }

  refreshAttentionCounter();
}

let _doneExpanded = false;
try { _doneExpanded = localStorage.getItem("llmt_done_expanded") === "1"; } catch {}

function renderDoneSection(items) {
  items.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  const now = Date.now();
  const DAY = 86400000;
  const today = items.filter(x => now - (x.lastActive || 0) < DAY).length;
  const older = items.length - today;
  const archivable = items.filter(x => now - (x.manualDone || x.lastActive || 0) > 7 * DAY).length;

  const wrap = mk("div", "sb-done-section");
  const header = mk("div", "sb-section-header sb-done-header" + (_doneExpanded ? " open" : ""));
  const chevron = mk("span", "sb-done-toggle");
  chevron.textContent = _doneExpanded ? "\u25BC" : "\u25B6";
  const label = mk("span", "sb-done-label");
  const summary = "\u2705 Done (" + items.length
    + (today ? " · " + today + " today" : "")
    + (older ? " · " + older + " older" : "")
    + ")";
  label.textContent = summary;
  header.appendChild(chevron);
  header.appendChild(label);

  if (archivable) {
    const archBtn = mk("button", "sb-done-archive-btn");
    archBtn.textContent = "Archive " + archivable + " (>7d)";
    archBtn.onclick = (e) => {
      e.stopPropagation();
      if (!confirm("Archive " + archivable + " done chats older than 7 days?")) return;
      fetch(apiUrl("/api/sessions/bulk-archive-done"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ olderThanDays: 7 }),
      }).then(r => r.json()).then(() => loadSessions()).catch(()=>{});
    };
    header.appendChild(archBtn);
  }

  wrap.appendChild(header);
  const list = mk("div", "sb-done-list");
  if (!_doneExpanded) list.style.display = "none";
  items.forEach(x => list.appendChild(makeSbItem(x, "ALL")));
  wrap.appendChild(list);

  header.onclick = (e) => {
    if (e.target.classList.contains("sb-done-archive-btn")) return;
    _doneExpanded = !_doneExpanded;
    try { localStorage.setItem("llmt_done_expanded", _doneExpanded ? "1" : "0"); } catch {}
    list.style.display = _doneExpanded ? "" : "none";
    chevron.textContent = _doneExpanded ? "\u25BC" : "\u25B6";
    header.classList.toggle("open", _doneExpanded);
  };
  sbList.appendChild(wrap);
}


// Detach ALL handlers from a WebSocket before closing so in-flight messages
// can't race into the next session's view. Without this, a message arriving
// on the old socket after we've already switched `session` global runs the
// onmessage handler against the new session — and renders old content in
// the new chat. ("Voice note from another chat populated my new chat" bug.)

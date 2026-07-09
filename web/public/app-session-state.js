// Session state, priority/attention UI — classic script, shares global scope with app.js.
// Extracted (refactor 2026-06-10).

function showSessionInfo_state(_x){} // marker

// Debounced trigger for the Haiku ROI re-score on the top-N sidebar items.
// Fires at most once per 60s so a re-render storm doesn't fan out into many
// /api/priority-roi-rescore calls.
let _rescoreLastFiredAt = 0;
let _rescoreInflight = false;
function triggerPriorityRescore(sessionIds) {
  if (!sessionIds || !sessionIds.length) return;
  const now = Date.now();
  if (now - _rescoreLastFiredAt < 60 * 1000) return;
  if (_rescoreInflight) return;
  _rescoreLastFiredAt = now;
  _rescoreInflight = true;
  fetch(apiUrl("/api/priority-roi-rescore"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_ids: sessionIds }),
  })
    .then(r => r.json()).then(d => {
      if (d && d.scored > 0) { try { loadSessions(); } catch {} }
    })
    .catch(() => {})
    .finally(() => { _rescoreInflight = false; });
}

// Tap the priority badge → small inline popover with the breakdown so the
// score is auditable. No black-box magic — every factor is shown.
function showPriorityBreakdown(x, anchorEl) {
  // Close any open popover first
  document.querySelectorAll(".sb-prio-pop").forEach(e => e.remove());
  const b = x.priority_breakdown || {};
  const lines = [
    `${x.priority_score || 0} = urgency ${b.urgency || 0} × ROI ${b.roi || 0} / 100`,
    `State: ${b.state || "?"}` + (b.has_deadline ? "  · deadline" : "") + (b.starred ? "  · ★" : ""),
    b.project_multiplier !== null ? `Project ROI base: ${b.project_multiplier} (${x.project})` : null,
    (b.matched_people && b.matched_people.length) ? `People: ${b.matched_people.join(", ")}` : null,
    b.has_money ? "Money / deal mentioned" : null,
    typeof b.haiku_score === "number"
      ? `Haiku: ${b.haiku_score}/100 — ${b.haiku_why || ""}`
      : "Haiku: (no rescore yet)",
    `Age: ${b.age_days != null ? b.age_days + "d" : "?"}`,
  ].filter(Boolean);
  const pop = mk("div", "sb-prio-pop");
  pop.innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join("");
  // Position near the anchor — appended to body, fixed-positioned just below
  document.body.appendChild(pop);
  const r = anchorEl.getBoundingClientRect();
  pop.style.top = (r.bottom + 4) + "px";
  pop.style.right = (window.innerWidth - r.right) + "px";
  const dismiss = (e) => {
    if (pop.contains(e.target)) return;
    pop.remove();
    document.removeEventListener("click", dismiss, true);
  };
  setTimeout(() => document.addEventListener("click", dismiss, true), 0);
}

function showSessionInfo(x, anchorEl) {
  // Native confirm + action menu — simple for mobile
  const state = computeSessionState(x);
  const isDone = state === "done";
  const action = confirm(
    (x.title || "(untitled)") + "\n\n" +
    "Project: " + (x.project || "?") + "\n" +
    "Messages: " + (x.messageCount || 0) + "\n" +
    "State: " + (state || "?") + "\n\n" +
    (isDone
      ? "Tap OK to mark this chat ACTIVE again (cancel to leave as DONE)."
      : "Tap OK to mark this chat DONE (cancel to leave it active).")
  );
  if (action) {
    fetch(apiUrl("/api/sessions/" + x.id + "/state"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manualDone: !isDone }),
    }).then(() => loadSessions()).catch(()=>{});
  }
}

// Compute chat state from session metadata. 5 states for triage:
//   blocked   — agent waiting on user (question / permission_denied) — RED, urgent
//   decision  — action item (email_draft) — YELLOW, your turn
//   responded — agent answered, no action needed — GREEN, read at leisure
//   working   — agent mid-task — GREY, leave alone
//   done      — logical end (email sent / manually marked / 24h+ idle responded) — MUTED, archive-ready
function computeSessionState(s) {
  if (!s) return "";
  const role = s.lastMessageRole || "";
  const ageMin = (Date.now() - (s.lastActive || 0)) / 60000;
  // Email reply (Phase B reactivation) — pulls the session back to "decision":
  // you need to read the reply and decide what to do.
  if (role === "email_reply") return s.manualDone ? "done" : "decision";
  // Email sent: only done when actually opened in Gmail or confirmed sent
  if (role === "email_sent") return "done";
  if (role === "email_draft" && s.emailOpened) return "done";
  if (role === "email_draft") return "decision";
  // Non-email: manualDone means done
  if (s.manualDone) return "done";
  if (role === "question" || role === "permission_denied") return "blocked";
  // V1.1: user_waiting — David sent a message but agent hasn't produced output yet
  if (s.awaitingResponse && role === "user") return "user_waiting";
  // "working" rolls of activity bumps lastActive on each tool_use/tool_result the
  // CLI streams. If we've gone >5 min without any bump, the claude process
  // almost certainly died mid-run — surface as "stalled" so it stops looking
  // like it's still thinking.
  if (role === "user" || role === "tool_activity" || role === "tool_result" || role === "permission_granted") {
    return ageMin > 5 ? "stalled" : "working";
  }
  // Responded: assistant replied, awaiting either a continuation from David or
  // an explicit "done" signal (manualDone, email_sent, contract-check supervisor
  // marking complete). We used to also flip to "done" when David had viewed the
  // session AND let it sit ≥30 min, but that false-positived on mid-task pauses
  // (look away → come back tomorrow → continue). The supervisor's contract-check
  // is the right place to decide "this conversation is actually finished"; this
  // UI shouldn't guess. 3-day-dormant fallback remains as a long-tail archive
  // nudge for sessions truly abandoned.
  if (role === "assistant") {
    if (ageMin > 3*24*60) return "done";
    return "responded";
  }
  return "";
}
// Pending optimistic updates kept across loadSessions() roundtrips so a slow
// server response doesn't wipe instant UI feedback.
const _pendingViewed = new Map();  // sessionId -> ts
const _pendingDone   = new Map();  // sessionId -> ts
function _applyPendingToList(list) {
  for (const [id, ts] of _pendingViewed) {
    const s = list.find(x => x.id === id);
    if (s && (s.lastViewed || 0) < ts) s.lastViewed = ts;
  }
  for (const [id, ts] of _pendingDone) {
    const s = list.find(x => x.id === id);
    if (s && !s.manualDone) s.manualDone = ts;
  }
}
function markSessionViewed(sessionId) {
  if (!sessionId) return;
  const now = Date.now();
  _pendingViewed.set(sessionId, now);
  const local = _allSessions.find(x => x.id === sessionId);
  if (local) local.lastViewed = now;
  _renderSidebar();
  fetch(apiUrl("/api/sessions/" + sessionId + "/viewed"), { method: "POST" })
    .then(() => { _pendingViewed.delete(sessionId); })
    .catch(() => {});
}
function markSessionDone(sessionId) {
  if (!sessionId) return;
  const now = Date.now();
  _pendingDone.set(sessionId, now);
  const local = _allSessions.find(x => x.id === sessionId);
  if (local) local.manualDone = now;
  _renderSidebar();
  fetch(apiUrl("/api/sessions/" + sessionId + "/state"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manualDone: true }),
  })
  .then(() => { _pendingDone.delete(sessionId); loadSessions(); })
  .catch(() => {});
}
// Re-engaging an archived/done chat (sending a message or voice note) should
// instantly bump it to the top of the active list — not wait 15s for the next
// poll. Mirror the server-side updates locally: bump lastActive, clear
// manualDone, drop the soft-archive flag. The next loadSessions() roundtrip
// will confirm.
function promoteCurrentSessionToActive() {
  if (!session || !Array.isArray(_allSessions)) return;
  const s = _allSessions.find(x => x.id === session.id);
  if (!s) return;
  s.lastActive = Date.now();
  s.manualDone = null;
  s.archived = false;
  try { _renderSidebar(); } catch {}
}
const STATE_ICONS = {
  blocked:      "❗",       // ❗
  decision:     "⚡",       // ⚡
  user_waiting: "◉",       // ◉  David sent a message, agent hasn't started
  stalled:      "⚠️",       // process exited mid-run, no final response
  responded:    "✓",       // ✓
  working:      "⏳",       // ⏳
  done:         "✅",       // ✅
};
const STATE_PRIORITY = { blocked: 0, decision: 1, user_waiting: 1.3, stalled: 1.5, responded: 2, working: 3, done: 4 };


// Round-robin through sessions that need attention. Tap = jump to next.
function attentionSessionsList() {
  return (_allSessions || [])
    .filter(s => !s.archived)
    .map(s => ({ s, st: computeSessionState(s) }))
    .filter(({st}) => st === "blocked" || st === "decision" || st === "user_waiting" || st === "stalled" || st === "responded")
    .sort((a, b) => {
      if (STATE_PRIORITY[a.st] !== STATE_PRIORITY[b.st]) return STATE_PRIORITY[a.st] - STATE_PRIORITY[b.st];
      return (b.s.lastActive || 0) - (a.s.lastActive || 0);
    })
    .map(({s}) => s);
}
function nextAttentionSession() {
  const list = attentionSessionsList();
  if (!list.length) return;
  const curIdx = list.findIndex(s => s.id === (session && session.id));
  const next = list[(curIdx + 1) % list.length];
  if (next) {
    resumeSession(next);
    showAttentionBanner(next);
  }
}
function showAttentionBanner(s) {
  let banner = document.getElementById("attBanner");
  if (!banner) {
    banner = mk("div", "att-banner"); banner.id = "attBanner";
    const chatEl = document.getElementById("chat");
    chatEl.parentNode.insertBefore(banner, chatEl);
  }
  const state = computeSessionState(s);
  const icon = STATE_ICONS[state] || "";
  const snippet = s.lastSnippet || "";
  const project = s.project || "";
  banner.innerHTML = "";
  const left = mk("div","att-banner-left");
  left.innerHTML = '<span class="att-banner-icon">' + icon + '</span> <strong>' + esc(s.title || "Untitled") + '</strong>';
  if (project) left.innerHTML += ' <span class="att-banner-proj">' + esc(project) + '</span>';
  banner.appendChild(left);
  if (snippet) {
    const snipEl = mk("div","att-banner-snippet");
    snipEl.textContent = snippet;
    banner.appendChild(snipEl);
  }
  banner.style.display = "flex";
  // Stay until the next bell-jump or an explicit tap. Previously auto-hid at
  // 5s, which on tablet meant David often missed the only on-screen indicator
  // of "what chat did I just land on" — the persistent topbar title now backs
  // this up but the banner stays as the richer first-glance card.
  if (banner._timer) { clearTimeout(banner._timer); banner._timer = null; }
  banner.onclick = () => { banner.style.display = "none"; };
}
function refreshAttentionCounter() {
  // Update topbar attention button (desktop)
  const topAtt = document.getElementById("topbarAtt");
  if (topAtt) {
    const list = attentionSessionsList();
    const n = list.length;
    const icon = document.getElementById("topbarAttIcon");
    const text = document.getElementById("topbarAttText");
    if (n === 0) {
      if (icon) icon.textContent = "✅";
      if (text) text.textContent = "";
      topAtt.classList.remove("has-attention");
    } else {
      if (icon) icon.textContent = "🔔 " + n;
      if (text) text.textContent = "";
      topAtt.classList.add("has-attention");
    }
  }
}

// (sidebar render fns moved to app-sidebar.js)
// (ws lifecycle moved to app-ws.js)

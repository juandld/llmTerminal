// Supervisors: the per-agent watchers (the downward axis of the agent model,
// ARCHITECTURE.md §4). spawnObserver mines what the run did; spawnDecisionExtractor
// records decisions; spawnContractCheck verifies the run actually finished;
// reconcileFileAttribution settles which files it touched. Extracted 2026-06-10.
const http = require("http");
const path = require("path");
const fs = require("fs");
const { PROJECTS_DIR } = require("./paths");
const { loadMessages, saveMessage, loadSessions, saveSessions, db } = require("./store");
const { broadcastToSession } = require("./ws/broadcast");
const { runCheapClaude } = require("./cheap-model");
const { logFileAttribution, buildAttributionMap, DRAWER_EXT_WHITELIST, DRAWER_EXCLUDED_DIRS } = require("./attribution");
const { autoDetectBashFiles, autoCreatePreview } = require("./tools");

function spawnObserver(sessionId, projectName) {
  try {
    if (!sessionId) return;
    const now = Date.now();
    if (_observerLastRun[sessionId] && (now - _observerLastRun[sessionId]) < OBSERVER_COOLDOWN_MS) return;
    _observerLastRun[sessionId] = now;

    // Load the most recent N messages for context
    const all = loadMessages(sessionId);
    if (all.length < OBSERVER_MIN_MESSAGES) return;
    const recent = all.slice(-25);  // bound prompt size

    // Build a compact conversation log
    const lines = recent.map(m => {
      const r = (m.role || "").toUpperCase();
      const t = m.text || m.summary || "";
      if (!t || r === "TOOL_ACTIVITY") return null;
      return `${r}: ${String(t).slice(0, 600)}`;
    }).filter(Boolean).join("\n\n");
    if (lines.length < 50) return;

    const prompt = `You are observing a chat between David (user) and an agent. Read the recent messages and identify any items David ASKED FOR that the agent did NOT clearly address or complete. Skip items the agent finished.

Output JSON ONLY (no prose, no markdown fences). If everything was addressed, output {"tasks":[]}. Otherwise:
{"tasks":[{"title":"short imperative","description":"more context, why it matters, what exact request from David","priority":"normal"}]}

Rules:
- Title: 5-12 words, imperative ("Add ...", "Fix ...", "Investigate ...")
- Description: include David's actual wording where possible
- Skip ideas the agent ALREADY DID
- Skip generic suggestions — only things David specifically asked for
- Max 3 tasks; pick the most concrete unfinished ones

Recent conversation:
${lines}`;

    console.log("[observer] firing for", sessionId, "(", recent.length, "msgs )");
    runCheapClaude(prompt, "observer", async (parsed) => {
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      if (!tasks.length) { console.log("[observer]", sessionId, "→ no unaddressed items"); return; }
      for (const t of tasks.slice(0, 3)) {
        if (!t.title) continue;
        try {
          const r = await fetch("http://127.0.0.1:7683/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: String(t.title).slice(0, 140),
              description: String(t.description || "").slice(0, 2000) + "\n\n— observed from session " + sessionId,
              project_id: (projectName || "").toLowerCase(),
              priority: t.priority || "normal",
            }),
          });
          const data = await r.json();
          console.log("[observer] +task:", t.title.slice(0, 60), "id=" + (data.item?.task_id || "?"));
        } catch (e) {
          console.error("[observer] task POST failed:", e.message);
        }
      }
    }, projectName);
  } catch (e) {
    console.error("[observer] outer error:", e.message);
  }
}

// ── Decision extractor (supervisor-pattern observer #2) ──
// Workers don't self-instrument their decisions — they shouldn't have to.
// Instead, after each run a separate cheap Haiku call reads the recent
// transcript and extracts decisions the worker made: forks where it picked
// between alternatives and closed off paths. Records each via the same
// /api/sessions/:id/decisions endpoint with mined=true so the user knows
// these are extracted, not explicitly declared.
const _decisionExtractorLastRun = {};   // sessionId -> ts of last extractor run
const _decisionHighWaterTs      = {};   // sessionId -> last ts we extracted past
const DECISION_EXTRACTOR_COOLDOWN_MS = 30000;
const DECISION_EXTRACTOR_MIN_MESSAGES = 4;

function spawnDecisionExtractor(sessionId, projectName) {
  try {
    if (!sessionId) return;
    const now = Date.now();
    if (_decisionExtractorLastRun[sessionId] && (now - _decisionExtractorLastRun[sessionId]) < DECISION_EXTRACTOR_COOLDOWN_MS) return;
    _decisionExtractorLastRun[sessionId] = now;

    const all = loadMessages(sessionId);
    if (all.length < DECISION_EXTRACTOR_MIN_MESSAGES) return;

    // Only consider messages newer than the last extraction high-water mark.
    const hwm = _decisionHighWaterTs[sessionId] || 0;
    const recent = all.filter(m => (m.ts || 0) > hwm).slice(-40);
    if (recent.length < 2) return;

    const lines = recent.map(m => {
      const r = (m.role || "").toUpperCase();
      let t = m.text || m.summary || "";
      if (r === "TOOL_ACTIVITY") {
        // Keep tool activity but truncate hard
        t = `(${m.tool_name || "tool"}) ${t}`.slice(0, 200);
      } else {
        t = String(t).slice(0, 800);
      }
      if (!t) return null;
      return `${r}: ${t}`;
    }).filter(Boolean).join("\n\n");
    if (lines.length < 80) return;

    // Pull last few already-recorded decisions for dedup hint.
    let prevSummary = "";
    try {
      const prev = db.prepare("SELECT summary, chose FROM decisions WHERE session_id = ? ORDER BY ts DESC LIMIT 8").all(sessionId);
      if (prev.length) {
        prevSummary = "\nAlready recorded (DO NOT duplicate these):\n" + prev.map(p => `  - ${p.summary} → chose: ${p.chose}`).join("\n");
      }
    } catch {}

    const prompt = `You are a supervisor agent observing a chat between a user and a worker agent. Your sole job is to identify DECISIONS the worker made and record them — the worker does NOT do this itself.

A decision is a moment where the agent:
  - chose between named alternatives (architecture, dependency, schema, file restructure)
  - bypassed or weakened a constraint
  - paused to ask the user instead of acting
  - reversed a previous direction

Skip:
  - routine tool calls (one Read, one Bash)
  - obvious mechanical steps (renaming a variable consistently)
  - things already in the "Already recorded" list

Output JSON ONLY (no prose, no markdown fences):
{"decisions":[{"summary":"one-line headline (verb phrase)","chose":"the option taken","alternatives":["option a","option b"],"why":"specific reasoning","constraints":["..."],"cost":"what was given up","status":"pending|verified|reversed"}]}

If nothing notable: {"decisions":[]}

Rules:
  - summary <= 14 words, verb-first ("Use ...", "Pause ...", "Defer ...")
  - alternatives: at minimum the one or two clear other paths that were closed off
  - why: cite the specific constraint or risk (no platitudes)
  - status: 'verified' if the chosen path demonstrably worked (commit landed, test passed, user accepted), 'reversed' if undone, 'pending' otherwise
  - max 3 decisions per call

${prevSummary}

Recent conversation (NEWEST AT BOTTOM):
${lines}`;

    console.log("[decision-extractor] firing for", sessionId, "(", recent.length, "msgs )");
    runCheapClaude(prompt, "decision-extractor", async (parsed) => {
      const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
      if (!decisions.length) { console.log("[decision-extractor]", sessionId, "→ none"); _decisionHighWaterTs[sessionId] = recent[recent.length - 1].ts || now; return; }
      for (const d of decisions) {
        const body = {
          summary: String(d.summary || "").trim(),
          chose:   String(d.chose   || "").trim(),
          alternatives: Array.isArray(d.alternatives) ? d.alternatives.map(String) : [],
          why:     String(d.why || "").trim(),
          constraints: Array.isArray(d.constraints) ? d.constraints.map(String) : [],
          cost:    d.cost ? String(d.cost).trim() : null,
          mined:   true,
        };
        if (!body.summary || !body.chose) continue;
        const post = JSON.stringify(body);
        const req = http.request({
          hostname: "127.0.0.1", port: 7683,
          path: `/api/sessions/${encodeURIComponent(sessionId)}/decisions`,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(post) },
        }, (res) => {
          let buf = "";
          res.on("data", c => buf += c);
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const j = JSON.parse(buf);
                const id = j.decision?.id;
                const status = (d.status === "verified" || d.status === "reversed") ? d.status : null;
                if (id && status) {
                  const upd = JSON.stringify({ status });
                  const r2 = http.request({
                    hostname: "127.0.0.1", port: 7683,
                    path: `/api/decisions/${id}/status`,
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(upd) },
                  });
                  r2.on("error", () => {});
                  r2.write(upd); r2.end();
                }
                console.log("[decision-extractor]", sessionId, "→ #" + id, body.summary.slice(0, 60));
              } catch {}
            } else {
              console.warn("[decision-extractor] POST failed:", res.statusCode, buf.slice(0, 200));
            }
          });
        });
        req.on("error", e => console.warn("[decision-extractor] POST error:", e.message));
        req.write(post); req.end();
      }
      _decisionHighWaterTs[sessionId] = recent[recent.length - 1].ts || now;
    }, projectName);
  } catch (e) {
    console.error("[decision-extractor] outer error:", e.message);
  }
}

// ── File-attribution reconciler (supervisor-pattern observer #4) ──
// After each agent run, walk the project dir for files modified during the run
// (mtime >= runStartTs) that have no positive attribution. Attribute them to
// the session that just ran. Catches files created by async subprocesses
// (Python scripts, etc.) whose paths never appeared in tool_use stdout/cmd.
// This is the "supervisor catches what fell through the cracks" pattern —
// programmatic enforcement of the file-attribution contract.
// Signature accepts a session object (or legacy sessionId/projectName for
// backwards compat) so it can read session.extra_project_dirs and walk those
// too — needed when an agent legitimately writes outside its primary project
// dir (e.g. narrativeHero-content session generating mp3s under crankHero/).
function reconcileFileAttribution(sessionOrId, projectNameOrStartTs, runStartTs) {
  try {
    let sessionId, projectName, extraDirs = [];
    if (typeof sessionOrId === "object" && sessionOrId) {
      sessionId = sessionOrId.id;
      projectName = sessionOrId.project;
      if (Array.isArray(sessionOrId.extra_project_dirs)) {
        for (const d of sessionOrId.extra_project_dirs) {
          if (typeof d === "string" && d.startsWith("/")) extraDirs.push(d);
        }
      }
      runStartTs = projectNameOrStartTs;
    } else {
      sessionId = sessionOrId;
      projectName = projectNameOrStartTs;
    }
    if (!sessionId || !projectName) return;
    const roots = [path.join(PROJECTS_DIR, projectName), ...extraDirs].filter(d => {
      try { return fs.existsSync(d); } catch { return false; }
    });
    if (!roots.length) return;
    const existing = buildAttributionMap();
    let added = 0;
    const stack = [...roots];
    while (stack.length && added < 500) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (ent.name.startsWith(".") && ent.name !== ".env") continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (DRAWER_EXCLUDED_DIRS.has(ent.name)) continue;
          stack.push(full);
          continue;
        }
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (!DRAWER_EXT_WHITELIST.has(ext)) continue;
        let stat; try { stat = fs.statSync(full); } catch { continue; }
        if (stat.mtimeMs < runStartTs) continue;       // not from this run
        if (existing.has(full)) continue;              // already attributed
        logFileAttribution(full, sessionId, "post-run-reconcile");
        added++;
      }
    }
    if (added > 0) console.log("[file-reconcile]", sessionId, "→ attributed", added, "unreported file(s) across", roots.length, "root(s)");
  } catch (e) {
    console.error("[file-reconcile] error:", e.message);
  }
}

// ─── Contract-check supervisor (set + clear manualDone) ───────────────────
// Fires after each assistant reply. Haiku judges whether the discrete task
// the user asked for has wrapped up. Two-way arbiter:
//   - judged done, not currently marked → set manualDone + write a banner
//   - judged done, already marked       → no-op (preserve)
//   - judged NOT done, currently marked → CLEAR manualDone (user re-engaged)
//   - judged NOT done, not marked       → no-op
// This is the sole automated source of truth for "task complete." We do NOT
// auto-clear manualDone on user typing alone (that wiped legitimate verdicts);
// the contract-check is the only thing allowed to flip the bit programmatically.
//
// NOTE: the file-pin half of the contract is enforced in real-time by
// autoCreatePreview + autoDetectBashFiles + the filesystem-derived drawer;
// reconcileFileAttribution() above catches the stragglers post-run.
const _contractCheckLastRun = {};
const CONTRACT_CHECK_COOLDOWN_MS = 30 * 1000;       // 30s — short, re-judges quickly after follow-ups
const CONTRACT_CHECK_MIN_MESSAGES = 4;

function spawnContractCheck(sessionId, projectName) {
  try {
    if (!sessionId) return;
    const now = Date.now();
    if (_contractCheckLastRun[sessionId] && (now - _contractCheckLastRun[sessionId]) < CONTRACT_CHECK_COOLDOWN_MS) return;
    _contractCheckLastRun[sessionId] = now;

    const sessions = loadSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    const wasDone = !!session.manualDone;

    // ── Pending-question enforcement ───────────────────────────────────────
    // If the agent called llmt_ask and the decision is still pending, the
    // session is BLOCKED on David's answer. Force lastMessageRole back to
    // "question" so the sidebar shows blocked (RED ❗) even if the agent
    // emitted closing assistant text after llmt_ask returned. Also clear
    // any manualDone — a pending question is not "done".
    if (db) {
      try {
        const ask = /^ask\s+(david|user|me)\b/i;
        const rows = db
          .prepare("SELECT id, chose, mined, status FROM decisions WHERE session_id = ? AND status = 'pending' ORDER BY ts DESC")
          .all(sessionId);
        const open = rows.find(r => !r.mined && ask.test(r.chose || ""));
        if (open) {
          let changed = false;
          if (session.lastMessageRole !== "question") {
            session.lastMessageRole = "question";
            session.lastSnippet = "Question waiting";
            changed = true;
          }
          if (session.manualDone) { delete session.manualDone; changed = true; }
          if (changed) {
            saveSessions(sessions);
            console.log("[contract-check]", sessionId.slice(0,8), "→ BLOCKED (open llmt_ask decision #" + open.id + ")");
          }
          return;
        }
      } catch (e) { console.error("[contract-check] pending-question check failed:", e.message); }
    }

    const all = loadMessages(sessionId);
    if (all.length < CONTRACT_CHECK_MIN_MESSAGES) return;
    const recent = all.slice(-20);

    // ── Browser tab etiquette (mechanical, warn-only) ─────────────────────
    // The shared per-project chromium is the operator's live browser. A run
    // that calls browser_navigate without ever creating its own tab via
    // browser_tabs is (very likely) driving the operator's tab — the
    // 2026-07-05 "browser keeps reloading by itself" incident. Tool results
    // aren't persisted (only tool names), so end-state URL comparison isn't
    // possible here; browser_run_code_unsafe may open pages internally and is
    // deliberately not judged. Warn, don't block.
    try {
      const lastUserIdx = all.map(m => m.role).lastIndexOf("user");
      const run = lastUserIdx >= 0 ? all.slice(lastUserIdx + 1) : all;
      const toolNames = run.filter(m => m.role === "tool_activity").map(m => String(m.tool_name || ""));
      const navigated = toolNames.includes("mcp__playwright__browser_navigate");
      const madeOwnTab = toolNames.includes("mcp__playwright__browser_tabs");
      const alreadyWarned = run.some(m => m.source === "contract_check_tab_etiquette");
      if (navigated && !madeOwnTab && !alreadyWarned) {
        saveMessage(sessionId, {
          role: "assistant",
          text: "⚠ Browser etiquette: this run navigated the shared chromium without opening its own tab (browser_navigate, no browser_tabs). The per-project browser is the operator's — verify in a NEW tab and restore the active tab when done (orchestratorHero CLAUDE.md → Browser verification etiquette).",
          ts: Date.now(),
          source: "contract_check_tab_etiquette",
        });
        try { broadcastToSession(sessionId, { type: "history", messages: loadMessages(sessionId) }); } catch {}
        console.log("[contract-check]", sessionId.slice(0, 8), "→ tab-etiquette warning (navigate without own tab)");
      }
    } catch (e) { console.error("[contract-check] tab-etiquette check failed:", e.message); }

    // Quick prefilter: skip if the last message isn't from the assistant, or if
    // the assistant is clearly mid-conversation (ends with a question mark, ends
    // with a request for input). Saves Haiku calls on obvious not-done states.
    const last = recent[recent.length - 1];
    if (!last || last.role !== "assistant") return;
    const lastText = String(last.text || "").trim();
    if (!lastText) return;
    // If the assistant ends with a clarifying question, work is NOT done.
    // Short-circuit: when already marked done, force-clear immediately (user
    // typed a follow-up that yielded a question — definitely active again).
    const endsWithQuestion = lastText.endsWith("?")
      || /\b(say|tell me|let me know|confirm|which|should i|do you want|would you like)\b[^\n.]*[?]?\s*$/i.test(lastText.slice(-200));
    if (endsWithQuestion) {
      if (wasDone) {
        delete session.manualDone;
        saveSessions(sessions);
        try { broadcastToSession(sessionId, { type: "history", messages: loadMessages(sessionId) }); } catch {}
        console.log("[contract-check]", sessionId.slice(0,8), "→ CLEARED (assistant asked clarifying question)");
      }
      return;
    }

    // [removed 2026-06-11] contract-check auto-done Haiku judge — depended on
    // buildRecentTranscript() which was never defined in any version, so this
    // path always threw and the feature was dead. Clarifying-question clear above is kept.
  } catch (e) {
    console.error("[contract-check] outer error:", e.message);
  }
}

// Run a queued prompt with no live WebSocket — full run, saves to disk,
// broadcasts to any clients that join mid-run. Mirrors sendToSession logic
// without the WS-specific streaming layer.

module.exports = { spawnObserver, spawnDecisionExtractor, spawnContractCheck, reconcileFileAttribution };

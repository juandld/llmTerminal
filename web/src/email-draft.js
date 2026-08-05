// email-draft: the SINGLE place a draft becomes an action card.
//
// Why this module exists (2026-07-29). Draft capture used to live only in
// ws/connection.js, inside the WebSocket stream handler. But a prompt sent
// while no browser is attached (phone asleep, app backgrounded, message
// queued) runs through fireQueueHeadless() in providers/claude.js — a
// SEPARATE copy of the same stream loop, which had no draft handling at all.
// Worse, its result path stripped ```email-draft fences from the reply text,
// so a headless draft was silently DELETED: no card, no DB row, no NEEDS YOU
// badge, nothing to reconnect to. David wrote a draft to Jói and it existed
// nowhere ("i dont see it anywhere"). It was never a rendering bug; the draft
// was thrown away before rendering was ever considered.
//
// The durability rule: PERSIST FIRST, broadcast second. saveMessage() is what
// survives a dead socket — email_draft is a STICKY_ROLE in ws/connection.js
// history replay, and priority.js maps it to "decision", so a persisted draft
// re-appears on reconnect AND lights the sidebar. The live push is a nicety
// for whoever happens to be watching. Any future runner (a third provider, a
// cron executor) gets correct behaviour by calling into here rather than
// re-deriving it — that duplication is exactly what broke this.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { saveMessage } = require("./store");
const { broadcastToSession } = require("./ws/broadcast");

const DRAFT_TOOL = "mcp__crankhero-draft__draft_email";

// ── Ledger ────────────────────────────────────────────────────────────────
// Every draft's lifecycle, appended as JSON lines. The failure this module was
// written for was invisible for months: 401 draft tool calls, 363 cards, and
// nothing anywhere recording the difference. Silence is the bug; a draft that
// dies must now leave a body.
//
//   requested — the model called the draft tool (tool_use seen)
//   saved     — persisted + pushed (the good path)
//   lost      — the run ended with a requested draft never captured  ← ALARM
//   orphan    — a payload arrived for a call we never saw requested
const LEDGER = path.join(os.homedir(), ".llm-terminal", "draft-ledger.jsonl");

function ledger(event, fields) {
  const row = Object.assign({ at: new Date().toISOString(), event }, fields);
  try {
    fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  } catch (e) {
    console.error("[email_draft] ledger append failed:", e.message);
  }
  return row;
}

// Matches the ```email-draft fenced block emitted by the /draft-email skill
// (the non-MCP path). Global + non-greedy: a turn may carry several.
const FENCE_RE = /```email-draft\n([\s\S]*?)\n```\s*/g;

// Map session.project -> default camoHero sending account. Every send still
// goes through camoHero/scripts/send_gmail_email.py — this only picks the
// right identity ("From:") for the session context.
function defaultFromAccountForProject(project) {
  const p = String(project || "").toLowerCase();
  if (p === "camohero") return "camofiles";
  // crankHero, narrativeHero, orchestratorHero, langHero, etc. → David's primary identity
  return "crankwheel";
}

// True when this tool_use block is a draft call whose result we must capture.
function isDraftToolUse(block) {
  return !!block && block.type === "tool_use" && block.name === DRAFT_TOOL;
}

// Record the intent to draft, at the moment the model asks for it. Pairs with
// reconcile() below: anything requested and not saved is a LOST draft.
// `runPath` names which of the two stream loops is handling this run, so the
// ledger says WHERE a loss happened, not just that one did.
function noteRequested(block, sessionId, runPath) {
  ledger("requested", { session_id: sessionId, tool_use_id: block.id,
                        to: (block.input && block.input.to) || null,
                        subject: (block.input && block.input.subject) || null,
                        run_path: runPath });
}

// Called when a run ends. Any tool_use id still pending was requested and never
// captured — the exact silent-loss shape. Make it loud in three places at once:
// the ledger (durable), the journal (operator), and the chat itself (David),
// because the whole failure mode was that none of the three said anything.
function reconcile(pendingDrafts, sessionId, project, runPath) {
  if (!pendingDrafts || pendingDrafts.size === 0) return 0;
  const lost = [...pendingDrafts];
  pendingDrafts.clear();
  for (const id of lost) {
    ledger("lost", { session_id: sessionId, tool_use_id: id, run_path: runPath, project });
    console.error(`[email_draft] LOST — draft requested (${id}) but no card was ` +
                  `captured for session ${sessionId} on ${runPath}. See ${LEDGER}`);
  }
  try {
    saveMessage(sessionId, {
      role: "assistant",
      text: `⚠ ${lost.length} email draft(s) were produced but did not reach you as an ` +
            `action card. Nothing was sent. Re-prompt to regenerate. ` +
            `(logged to draft-ledger.jsonl, run path: ${runPath})`,
      ts: Date.now(),
      synthetic: "email-draft-lost",
    });
  } catch (e) {
    console.error("[email_draft] could not surface the loss in chat:", e.message);
  }
  return lost.length;
}

// Normalise a raw draft payload into the wire/DB shape. Returns null when the
// payload is not a usable draft (missing recipient/subject/body).
function _normalise(payload, sessionId, project) {
  if (!payload || typeof payload !== "object") return null;
  if (!payload.to || !payload.subject || !payload.body) return null;
  return {
    type: "email_draft",
    to: payload.to || "",
    cc: payload.cc || "",
    subject: payload.subject || "",
    body: payload.body || "",
    thread_id: payload.thread_id || "",
    reply_mode: payload.reply_mode || "",
    thread_participants: Array.isArray(payload.thread_participants) ? payload.thread_participants : [],
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    project,
    default_from_account: defaultFromAccountForProject(project),
    // Frontend locks to the first session_id it sees and drops mismatches at
    // the protocol level — an action card without one gets discarded.
    session_id: sessionId,
    ts: Date.now(),
  };
}

// Notify crankHero's authoritative comm-event store (data/crm.db) that a draft
// exists. Fire-and-forget: the CRM record must never block or break the draft
// flow. Localhost call with the CF-Access header the dashboard trusts (same
// pattern as crankHero/scripts/verify_crm.sh). Only crankHero-identity drafts
// belong in that DB (one store per organization — see crankHero
// development/crm-single-source-plan.md).
function notifyCrmCommEvent(body) {
  try {
    const data = JSON.stringify(body);
    const req = require("http").request({
      host: "127.0.0.1", port: 3001, path: "/crm/api/comm_events", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "Cf-Access-Authenticated-User-Email": "david@crankwheel.com",
      },
      timeout: 4000,
    }, res => { res.resume(); });
    req.on("error", e => console.error("[email_draft] comm-event notify failed (draft unaffected):", e.message));
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.write(data); req.end();
  } catch (e) {
    console.error("[email_draft] comm-event notify failed (draft unaffected):", e.message);
  }
}

// Persist + push one draft. Persistence is what makes it survive; a throw from
// the broadcast side must never lose the row, hence the ordering and the catch.
function emitDraft(payload, sessionId, project) {
  const draft = _normalise(payload, sessionId, project);
  if (!draft) {
    console.warn("[email_draft] payload missing to/subject/body — not a draft, ignored");
    return null;
  }
  const { type, ...row } = draft;
  saveMessage(sessionId, Object.assign({ role: "email_draft" }, row));
  try {
    broadcastToSession(sessionId, draft);
  } catch (e) {
    console.error("[email_draft] broadcast failed (draft IS saved, will replay on reconnect):", e.message);
  }
  // Ledger attribution: derive project from the session store at write time
  // rather than trusting the caller's parameter. A 2026-08-04 draft was
  // ledgered with project=orchestratorHero for a crankHero session; the store
  // is the single source of truth for a session's project.
  let ledgerProject = project;
  try {
    const { loadSessions } = require("./store");
    const s = loadSessions().find(x => x.id === sessionId);
    if (s && s.project) {
      if (s.project !== project) {
        console.warn(`[email_draft] project mismatch: caller said '${project}' but ` +
                     `session ${sessionId} is '${s.project}' — using the store's value`);
      }
      ledgerProject = s.project;
    }
  } catch (e) { /* ledger attribution best-effort; never block the draft */ }
  ledger("saved", { session_id: sessionId, to: draft.to, subject: draft.subject,
                    project: ledgerProject, caller_project: project, ts: draft.ts });
  if (draft.default_from_account === "crankwheel") {
    notifyCrmCommEvent({
      action: "draft", to: draft.to, cc: draft.cc, subject: draft.subject,
      thread_id: draft.thread_id, attachments: draft.attachments,
    });
  }
  console.log(`[email_draft] captured for ${sessionId}: "${draft.subject.slice(0, 60)}" -> ${draft.to}`);
  return draft;
}

// Capture the MCP tool_result for a tracked draft call.
// `pendingDrafts` is a Set of tool_use ids, owned by the caller's run.
function captureToolResult(block, pendingDrafts, sessionId, project) {
  if (!block || block.type !== "tool_result" || !block.tool_use_id) return null;
  if (!pendingDrafts.has(block.tool_use_id)) return null;
  pendingDrafts.delete(block.tool_use_id);
  if (block.is_error) {
    console.warn("[email_draft] draft tool returned an error — nothing to capture");
    return null;
  }
  let raw = block.content;
  if (Array.isArray(raw)) raw = (raw[0] && raw[0].text) || "";
  try {
    const payload = JSON.parse(raw);
    if (!payload || payload.type !== "email_draft") return null;
    return emitDraft(payload, sessionId, project);
  } catch (e) {
    console.error("[email_draft] tool_result parse failed:", e.message);
    return null;
  }
}

// Capture any ```email-draft fences in assistant text, and return the text with
// those fences removed (so the card doesn't render doubled alongside raw JSON).
// Callers MUST use the returned string — dropping fences without capturing is
// the exact data loss this module exists to prevent.
function captureFences(text, sessionId, project) {
  if (!text || text.indexOf("```email-draft") === -1) return text;
  FENCE_RE.lastIndex = 0;
  const matches = [...text.matchAll(FENCE_RE)];
  for (const m of matches) {
    try {
      emitDraft(JSON.parse(m[1]), sessionId, project);
    } catch (e) {
      console.error("[email_draft] fence parse failed:", e.message);
    }
  }
  return text.replace(FENCE_RE, "").trim();
}

module.exports = {
  DRAFT_TOOL,
  LEDGER,
  defaultFromAccountForProject,
  isDraftToolUse,
  noteRequested,
  reconcile,
  emitDraft,
  captureToolResult,
  captureFences,
  notifyCrmCommEvent,
};

// Session priority scoring (state, score, ROI multipliers) + the haiku-ROI
// cache. Extracted from server.js (refactor 2026-06-10, phase 10). _roiHaikuCache
// is exported by reference so the rescore route keeps populating it.
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const ARCHIVE_INACTIVE_DAYS = 30;
// ─── Priority scoring ────────────────────────────────────────────────────────
// Each session gets a deterministic priority_score so the sidebar can rank
// "what to work on next" by time × ROI rather than just newest-first. The
// breakdown is exposed alongside so taps on the badge can show the why.
const PRIORITY_DEFAULTS = {
  project_roi_multipliers: {
    crankHero: 100, camoHero: 80, mediaHero: 60,
    langHero: 40, dataHero: 40, orchestratorHero: 30, llmTerminal: 20,
  },
  important_people: [
    "Birta", "Joi", "Tav", "Brandon", "Studi",
    "GoodLeap", "Washington National", "Valentina", "SelectQuote",
  ],
};
const PRIORITY_SETTINGS_FILE = path.join(DATA_DIR, "priority_settings.json");

function loadPrioritySettings() {
  try {
    const f = JSON.parse(fs.readFileSync(PRIORITY_SETTINGS_FILE, "utf8"));
    return {
      project_roi_multipliers: { ...PRIORITY_DEFAULTS.project_roi_multipliers, ...(f.project_roi_multipliers || {}) },
      important_people: Array.isArray(f.important_people) ? f.important_people : PRIORITY_DEFAULTS.important_people,
    };
  } catch { return { ...PRIORITY_DEFAULTS }; }
}

// Port of frontend computeSessionState — kept in sync so server-side ranking
// matches the badge color the user sees.
function computeSessionStateServer(s) {
  const role = s.lastMessageRole || "";
  const ageMin = (Date.now() - (s.lastActive || 0)) / 60000;
  if (role === "email_reply") return s.manualDone ? "done" : "decision";
  if (role === "email_sent") return "done";
  if (role === "email_draft" && s.emailOpened) return "done";
  if (role === "email_draft") return "decision";
  if (s.manualDone) return "done";
  if (role === "question" || role === "permission_denied") return "blocked";
  // V1.1: user_waiting — David sent a message but the agent hasn't produced
  // any output yet. Only when the last role is "user" (not tool_activity etc.,
  // which means the agent IS running).
  if (s.awaitingResponse && role === "user") return "user_waiting";
  if (role === "user" || role === "tool_activity" || role === "tool_result" || role === "permission_granted") {
    return ageMin > 5 ? "stalled" : "working";
  }
  if (role === "assistant") {
    if (ageMin > 3 * 24 * 60) return "done";
    return "responded";
  }
  return "";
}

const STATE_URGENCY = { blocked: 100, decision: 80, user_waiting: 60, responded: 40, stalled: 30, working: 20, done: 0 };
const DEADLINE_RE = /\b(by|due|before|deadline)\s+(today|tomorrow|EOD|noon|\d{1,2}(?:am|pm)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const MONEY_RE = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b|\b\d+k\b|\binvoice\b|\bcommission\b|\bpayment\b|\bdeal\b/i;

function computePrioritySession(s, settings) {
  const state = computeSessionStateServer(s);
  const ageMs = Date.now() - (s.lastActive || s.created || Date.now());
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const snippetText = String(s.lastSnippet || "") + " " + String(s.title || "");

  // Urgency — state weight, age decay for stale things, deadline boost, reply boost.
  let urgency = STATE_URGENCY[state] ?? 30;
  if (ageDays > 1) urgency *= Math.max(0.2, 1 - (ageDays - 1) * 0.2);
  const hasDeadline = DEADLINE_RE.test(snippetText);
  if (hasDeadline) urgency += 20;
  if (s.lastMessageRole === "email_reply" && !s.manualDone) urgency += 20;
  urgency = Math.max(0, Math.min(120, urgency));

  // ROI — Haiku-judged score replaces the deterministic ROI when available
  // (Phase 4), otherwise: project base + people boost + money boost.
  // Star always sets a floor.
  const projMult = settings.project_roi_multipliers[s.project];
  const baseRoi = (typeof projMult === "number") ? projMult : 50;
  const matchedPeople = settings.important_people.filter(p =>
    p && snippetText.toLowerCase().includes(p.toLowerCase())
  );
  const hasMoney = MONEY_RE.test(snippetText);
  const haiku = _roiHaikuLookup(s.id);
  let roi;
  if (haiku) {
    // Haiku scores 0-100; lift to the 0-200 ROI scale so it can override
    // project-base ceilings when the model says "yes this is genuinely valuable."
    roi = haiku.score * 1.5;
  } else {
    roi = baseRoi;
    if (matchedPeople.length > 0) roi += 15 * matchedPeople.length;
    if (hasMoney) roi += 15;
  }
  if (s.starred) roi = Math.max(roi, 80);
  roi = Math.max(0, Math.min(200, roi));

  // Combined: urgency × roi / 100, capped at 999 so badges fit
  const score = Math.max(0, Math.min(999, Math.round((urgency * roi) / 100)));
  return {
    score,
    breakdown: {
      state,
      urgency: Math.round(urgency),
      roi: Math.round(roi),
      age_days: Math.round(ageDays * 10) / 10,
      matched_people: matchedPeople,
      has_deadline: hasDeadline,
      has_money: hasMoney,
      starred: !!s.starred,
      project_multiplier: (typeof projMult === "number") ? projMult : null,
      haiku_score: haiku ? haiku.score : null,
      haiku_why: haiku ? haiku.why : null,
      haiku_age_ms: haiku ? Date.now() - haiku.computed_at : null,
    },
  };
}

// ─── Haiku ROI re-score (Phase 4) ─────────────────────────────────────────────
// In-memory cache: sessionId -> { score: 0-100, why, computed_at }.
// 15-min TTL. The frontend triggers a rescore on the top-N visible sessions;
// computePrioritySession layers the cached value over the deterministic ROI.
const _roiHaikuCache = new Map();
const ROI_HAIKU_TTL_MS = 15 * 60 * 1000;
const ROI_HAIKU_CACHE_FILE = path.join(DATA_DIR, "priority_roi_cache.json");

// Best-effort persist so a server restart doesn't blow away the cache.
function _persistRoiCache() {
  try {
    const dump = {};
    for (const [k, v] of _roiHaikuCache) dump[k] = v;
    fs.writeFileSync(ROI_HAIKU_CACHE_FILE, JSON.stringify(dump));
  } catch {}
}
function _loadRoiCache() {
  try {
    const d = JSON.parse(fs.readFileSync(ROI_HAIKU_CACHE_FILE, "utf8"));
    const now = Date.now();
    for (const [k, v] of Object.entries(d)) {
      if (v && typeof v.score === "number" && v.computed_at && (now - v.computed_at < ROI_HAIKU_TTL_MS)) {
        _roiHaikuCache.set(k, v);
      }
    }
  } catch {}
}
_loadRoiCache();

function _roiHaikuLookup(sessionId) {
  const v = _roiHaikuCache.get(sessionId);
  if (!v) return null;
  if (Date.now() - v.computed_at > ROI_HAIKU_TTL_MS) {
    _roiHaikuCache.delete(sessionId);
    return null;
  }
  return v;
}

module.exports = {
  loadPrioritySettings, computeSessionStateServer, computePrioritySession,
  _persistRoiCache, _roiHaikuLookup, _roiHaikuCache, ARCHIVE_INACTIVE_DAYS,
};

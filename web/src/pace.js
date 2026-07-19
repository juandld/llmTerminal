// pace.js — Claude-limit pace engine (2026-07-19). David: "the system needs
// to be aware of how close we are to the limit — hourly limit, weekly limit;
// divide the week into a daily amount; smooth that curve; in the gaps use the
// Gemini/GPT models."
//
// Three jobs, one module:
//
//   1. USAGE — rolling Claude usage (cost_usd always; tokens where the row
//      carries them) over the trailing 5h session window, the trailing 7d
//      week, and the local day. Source: the SAME shared spend ledger both
//      governors write (orchestratorHero/storage/usage/claude_spend.jsonl —
//      node's governor.record() for chat/auto/cheap runs, python's
//      usage_governor for queue runs). Rows with billing:"api" are
//      OpenAI/Google dollars and are EXCLUDED — Anthropic's limits only move
//      on plan usage. cost_usd on plan rows is the CLI's LIST-PRICE
//      EQUIVALENT (a usage weight, not billed dollars) — exactly the unit the
//      plan meter moves in, so it is the right pacing currency.
//      Boot = one full scan; afterwards every state() call tails only the
//      bytes appended since the last read (the ledger is append-only, and a
//      write-side hook would miss python's rows — the tail-read catches
//      everyone's).
//
//   2. CEILINGS — calibrated from OBSERVED limit hits, never guessed.
//      attention.js handleTokenLimitError() calls recordLimitHit() on every
//      parsed session/usage-limit error; each hit persists
//      {ts, kind, usage_5h_at_hit, usage_7d_at_hit, reset_at} to
//      ~/.llm-terminal/claude-limits.json. Ceiling per kind = MAX observed
//      usage-at-hit (no decay, no adjustment — max is fine). kind:"weekly"
//      when the reset is >24h out OR the error text says weekly; otherwise
//      "session". Until a weekly hit is EVER observed, the weekly ceiling is
//      session_ceiling × LLMT_PACE_WEEKLY_FACTOR (default 20 ≈ four
//      fully-burned 5h windows/day × 7d, discounted for sleep/overlap) and is
//      marked ceiling_source:"estimate" — never presented as observed. With
//      NO hits at all, ceilings are null and pacing is INERT (hot=false,
//      pct=null): the engine fails open until reality calibrates it.
//
//   3. SIGNAL — state() returns {day, session_window, week,
//      offload_recommended, note}. day.hot uses
//        used > daily_target × max(frac_of_day_elapsed, 0.25)
//      — the 0.25 floor means you may burn up to a quarter of the daily
//      target before ANY hour of the day reads hot, so 6am spikes don't
//      hair-trigger. governorVerdict() folds (day.hot OR session pct > 0.85)
//      into one defer verdict that governor.js consults for the
//      "llmterminal-auto" lane ONLY (escape hatch LLMT_PACE_GOVERNOR=off;
//      interactive chat is NEVER pace-gated). offload_recommended mirrors the
//      same condition for consumers (nh-backend enrichment, future routers)
//      that read GET /api/pace and should route medium-to-high-effort work to
//      the capped GPT/Gemini lanes while Claude cools. This module is the
//      authoritative signal only — task-level offload routing lives with the
//      consumers.
//
// Env: HERO_USAGE_DIR (ledger dir — mirrors governor.js byte-for-byte; kept
// require-free of governor so the two stay cycle-safe), LLMT_PACE_STATE_FILE
// (harness override for the calibration file), LLMT_PACE_WEEKLY_FACTOR,
// LLMT_PACE_GOVERNOR=off (consumed in governor.js check()).
//
// Nothing here ever throws at a caller: ledger/state-file trouble degrades to
// zero usage / null ceilings — never to a blocked run.
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const USAGE_DIR = process.env.HERO_USAGE_DIR
  || "/home/claude-user/projects/orchestratorHero/storage/usage";
const LEDGER = path.join(USAGE_DIR, "claude_spend.jsonl");
const STATE_FILE = process.env.LLMT_PACE_STATE_FILE
  || path.join(DATA_DIR, "claude-limits.json");
const WEEKLY_FACTOR = (() => {
  const v = parseFloat(process.env.LLMT_PACE_WEEKLY_FACTOR);
  return Number.isFinite(v) && v > 0 ? v : 20;
})();

const SESSION_WINDOW_MS = 5 * 3600e3;
const WEEK_MS = 7 * 86400e3;
const DAY_MS = 86400e3;
const HIT_DEDUPE_MS = 5 * 60e3;    // same-kind hits inside 5min = one observation
const SESSION_PCT_DEFER = 0.85;    // governor defers above this fraction of the 5h ceiling
const DAY_FRAC_FLOOR = 0.25;       // early-morning hair-trigger floor

const _r6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const _r4 = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4;

// ---- usage aggregation (in-memory 7d window over the append-only ledger) ----
let _rows = [];     // [{ts(ms), cost, tokens}] Claude rows in the trailing 7d
let _offset = -1;   // ledger bytes consumed; -1 = never scanned (boot)
let _carry = "";    // partial trailing line carried between tail reads

function _isClaudeRow(row) {
  // billing:"api" = OpenAI/Google keys (providers/openai.js, providers/
  // google.js). Everything else — billing:"plan" and legacy/python rows with
  // no billing field — is a Claude run and counts against Anthropic's limits.
  return row && row.billing !== "api";
}

function _refresh(nowMs) {
  let st;
  try { st = fs.statSync(LEDGER); }
  catch { _rows = []; _offset = 0; _carry = ""; return; } // no ledger = zero usage
  if (_offset < 0 || st.size < _offset) { _rows = []; _offset = 0; _carry = ""; } // boot, or truncation/rotation → full rescan
  if (st.size > _offset) {
    let fd;
    try {
      fd = fs.openSync(LEDGER, "r");
      const want = st.size - _offset;
      const buf = Buffer.alloc(want);
      const got = fs.readSync(fd, buf, 0, want, _offset);
      _offset += got;
      const chunk = _carry + buf.toString("utf8", 0, got);
      const lines = chunk.split("\n");
      _carry = lines.pop(); // "" when the chunk ended in \n, else the partial line
      const cutoff = nowMs - WEEK_MS;
      for (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!_isClaudeRow(row)) continue;
        const tsMs = (Number(row.ts) || 0) * 1000; // ledger ts is epoch-seconds
        if (!tsMs || tsMs < cutoff) continue;
        _rows.push({
          ts: tsMs,
          cost: Number(row.cost_usd) || 0,
          tokens: (Number(row.tokens_in) || 0) + (Number(row.tokens_out) || 0),
        });
      }
    } catch (e) {
      console.warn("[pace] ledger tail read failed:", e.message);
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }
  const cutoff = nowMs - WEEK_MS;
  _rows = _rows.filter((r) => r.ts >= cutoff); // rolling prune (backfills may be out of order — filter, don't assume sorted)
}

function _usage(nowMs) {
  _refresh(nowMs);
  const d = new Date(nowMs);
  const midnightMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  const frac = Math.min(1, Math.max(0, (nowMs - midnightMs) / DAY_MS));
  const cut5 = nowMs - SESSION_WINDOW_MS;
  let c5 = 0, t5 = 0, c7 = 0, t7 = 0, cDay = 0, tDay = 0, runs = 0;
  for (const r of _rows) {
    if (r.ts > nowMs) continue; // future-dated rows (clock skew) count when their time comes
    c7 += r.cost; t7 += r.tokens; runs += 1;
    if (r.ts >= cut5) { c5 += r.cost; t5 += r.tokens; }
    if (r.ts >= midnightMs) { cDay += r.cost; tDay += r.tokens; }
  }
  return {
    cost_5h: c5, tokens_5h: t5,
    cost_7d: c7, tokens_7d: t7,
    cost_day: cDay, tokens_day: tDay,
    frac_of_day_elapsed: frac, runs_7d: runs,
  };
}

// ---- ceiling calibration (persisted observed limit hits) ----
let _hits = null; // lazy cache of the persisted hit list

function _loadHits() {
  if (_hits) return _hits;
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    _hits = Array.isArray(j.hits)
      ? j.hits.filter((h) => h && (h.kind === "session" || h.kind === "weekly"))
      : [];
  } catch { _hits = []; } // first run / unreadable = start empty
  return _hits;
}

function _saveHits() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      updated_at: new Date().toISOString(),
      note: "Observed Claude limit hits (pace.js calibration). Ceiling per kind = max usage-at-hit.",
      hits: _hits,
    }, null, 2));
  } catch (e) {
    console.warn("[pace] calibration save failed:", e.message);
  }
}

// A zero/negative observation can't calibrate (usage/0 → pct Infinity would
// park the lane forever) — only positive usage-at-hit sets a ceiling.
function _ceilings() {
  let session = null, weekly = null;
  for (const h of _loadHits()) {
    if (h.kind === "session") {
      const v = Number(h.usage_5h_at_hit) || 0;
      if (v > 0) session = session == null ? v : Math.max(session, v);
    } else if (h.kind === "weekly") {
      const v = Number(h.usage_7d_at_hit) || 0;
      if (v > 0) weekly = weekly == null ? v : Math.max(weekly, v);
    }
  }
  return { session, weekly };
}

// Called from attention.js handleTokenLimitError on every parsed
// session/usage-limit api_error. Never throws.
// { resetAtMs, text?, nowMs? } → { recorded|deduped, kind } | null.
function recordLimitHit({ resetAtMs, text, nowMs } = {}) {
  try {
    const now = Number(nowMs) || Date.now();
    const resetAt = Number(resetAtMs) || null;
    const kind = ((resetAt != null && resetAt - now > 24 * 3600e3) || /\bweek(?:ly|s)?\b/i.test(String(text || "")))
      ? "weekly" : "session";
    const hits = _loadHits();
    for (let i = hits.length - 1; i >= 0; i--) {
      if (hits[i].kind !== kind) continue;
      if (now - (Number(hits[i].ts) || 0) < HIT_DEDUPE_MS) return { deduped: true, kind };
      break; // only the latest same-kind hit matters for dedupe
    }
    const u = _usage(now);
    const hit = {
      ts: now,
      iso: new Date(now).toISOString(),
      kind,
      usage_5h_at_hit: _r6(u.cost_5h),
      usage_7d_at_hit: _r6(u.cost_7d),
      tokens_5h_at_hit: u.tokens_5h,
      tokens_7d_at_hit: u.tokens_7d,
      reset_at: resetAt != null ? new Date(resetAt).toISOString() : null,
    };
    hits.push(hit);
    _saveHits();
    console.log("[pace] limit hit recorded:", kind,
      "usage_5h=" + hit.usage_5h_at_hit.toFixed(2),
      "usage_7d=" + hit.usage_7d_at_hit.toFixed(2),
      "reset", hit.reset_at || "?");
    return { recorded: true, kind, hit };
  } catch (e) {
    console.warn("[pace] recordLimitHit failed (run pipeline unaffected):", e.message);
    return null;
  }
}

// ---- the pace state ----
function state(nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  const u = _usage(now);
  const ceil = _ceilings();
  const weeklyEffective = ceil.weekly != null
    ? ceil.weekly
    : (ceil.session != null ? _r6(ceil.session * WEEKLY_FACTOR) : null);
  const weeklySource = ceil.weekly != null
    ? "observed"
    : (ceil.session != null ? "estimate" : null); // estimate = session_ceiling × WEEKLY_FACTOR, see header
  const dailyTarget = weeklyEffective != null ? _r6(weeklyEffective / 7) : null;
  const frac = u.frac_of_day_elapsed;
  const allowedFrac = Math.max(frac, DAY_FRAC_FLOOR);
  const hot = dailyTarget != null && u.cost_day > dailyTarget * allowedFrac;
  const sessionPct = ceil.session != null ? _r4(u.cost_5h / ceil.session) : null;
  const weekPct = weeklyEffective != null ? _r4(u.cost_7d / weeklyEffective) : null;
  const offload = hot || (sessionPct != null && sessionPct > SESSION_PCT_DEFER);
  let note;
  if (dailyTarget == null && ceil.session == null) {
    note = "uncalibrated — no limit hits observed yet; pacing is inert until the first hit records a ceiling";
  } else if (hot) {
    note = "day used " + u.cost_day.toFixed(2) + " > " + (dailyTarget * allowedFrac).toFixed(2) +
      " allowed (daily target " + dailyTarget.toFixed(2) + " × " + Math.round(allowedFrac * 100) +
      "% elapsed, floor 25%) — offload medium-to-high-effort work to the capped GPT/Gemini lanes";
  } else if (sessionPct != null && sessionPct > SESSION_PCT_DEFER) {
    note = "5h window at " + Math.round(sessionPct * 100) + "% of the observed session ceiling (" +
      ceil.session.toFixed(2) + ") — offload medium-to-high-effort work to the capped GPT/Gemini lanes";
  } else {
    note = "within pace";
  }
  const hits = _loadHits();
  return {
    now: new Date(now).toISOString(),
    // units: cost_usd list-price equivalents from the spend ledger (the plan
    // meter's currency), NOT billed dollars. tokens are summed where rows
    // carry tokens_in/out (API rows do; Claude plan rows currently don't).
    day: {
      used: _r6(u.cost_day),
      tokens: u.tokens_day,
      target: dailyTarget,
      frac_of_day_elapsed: _r4(frac),
      hot,
    },
    session_window: {
      used_5h: _r6(u.cost_5h),
      tokens_5h: u.tokens_5h,
      ceiling: ceil.session,
      pct: sessionPct,
    },
    week: {
      used_7d: _r6(u.cost_7d),
      tokens_7d: u.tokens_7d,
      ceiling: weeklyEffective,
      ceiling_source: weeklySource, // "observed" | "estimate" (session×factor) | null
      ceiling_observed: ceil.weekly,
      pct: weekPct,
    },
    offload_recommended: offload,
    note,
    calibration: {
      hits: hits.length,
      session_hits: hits.filter((h) => h.kind === "session").length,
      weekly_hits: hits.filter((h) => h.kind === "weekly").length,
      weekly_factor: WEEKLY_FACTOR,
      state_file: STATE_FILE,
    },
    runs_7d: u.runs_7d,
    ledger: LEDGER,
  };
}

// One verdict for governor.js check("llmterminal-auto"): defer when the day is
// hot OR the 5h window is >85% burned. Never throws; trouble = no defer
// (pace must never park the lane by accident).
function governorVerdict(nowMs = Date.now()) {
  try {
    const s = state(nowMs);
    if (s.day.hot) {
      return {
        defer: true,
        detail: "day used " + s.day.used.toFixed(2) + " > " +
          (s.day.target * Math.max(s.day.frac_of_day_elapsed, DAY_FRAC_FLOOR)).toFixed(2) +
          " allowed (smoothed daily target " + s.day.target.toFixed(2) + ", " +
          Math.round(s.day.frac_of_day_elapsed * 100) + "% of day elapsed, floor 25%)",
      };
    }
    const pct = s.session_window.pct;
    if (pct != null && pct > SESSION_PCT_DEFER) {
      return {
        defer: true,
        detail: "5h window at " + Math.round(pct * 100) + "% of observed session ceiling " +
          s.session_window.ceiling.toFixed(2) + " (defer above " + Math.round(SESSION_PCT_DEFER * 100) + "%)",
      };
    }
    return { defer: false, detail: "" };
  } catch (e) {
    return { defer: false, detail: "pace unavailable: " + e.message };
  }
}

// GET /api/pace — loopback, no auth, same posture as /api/session-costs.
function registerRoutes(app) {
  app.get("/api/pace", (_req, res) => {
    try { res.json(state()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}

// Harness hook: drop all in-memory caches so the next call re-reads disk.
function _testReset() {
  _rows = [];
  _offset = -1;
  _carry = "";
  _hits = null;
}

module.exports = {
  state, recordLimitHit, governorVerdict, registerRoutes,
  LEDGER, STATE_FILE, _testReset,
};

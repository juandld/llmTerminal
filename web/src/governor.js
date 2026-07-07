// governor.js — llmTerminal's client of the shared hero usage governor
// (loop-hardening WS3a, 2026-07-04; David's decision: automated-paths-only).
//
// One ledger, one gate, shared with orchestratorHero's python governor
// (scripts/usage_governor.py) via the SAME files — node reads/writes them
// directly, no IPC:
//     orchestratorHero/storage/usage/claude_spend.jsonl   append-only {ts, iso, component, model, cost_usd, meta?}
//     orchestratorHero/storage/usage/limit_state.json     provider-limit cooldown (read-only here; python writes it)
//
// Policy split (do NOT collapse it):
//   - AUTOMATED spawn paths (retries, startup recovery, wake re-fires,
//     supervisors/title-gen) call check() before spawning and stand down when
//     capped — component "llmterminal-auto" / "llmterminal-cheap".
//   - INTERACTIVE turns David initiates are NEVER blocked; they only record()
//     their spend for ledger visibility — component "llmterminal-chat".
//
// Caps mirror the python defaults and honor the same env overrides, so both
// governors always agree on where the line is.
const fs = require("fs");
const path = require("path");

const USAGE_DIR = process.env.HERO_USAGE_DIR
  || "/home/claude-user/projects/orchestratorHero/storage/usage";
const LEDGER = path.join(USAGE_DIR, "claude_spend.jsonl");
const LIMIT_STATE = path.join(USAGE_DIR, "limit_state.json");

const HOURLY_USD = parseFloat(process.env.HERO_CLAUDE_HOURLY_USD || "12");
const DAILY_USD = parseFloat(process.env.HERO_CLAUDE_DAILY_USD || "50");
const CALLS_PER_HOUR = parseInt(process.env.HERO_CLAUDE_CALLS_PER_HOUR || "40", 10);

// Interactive components record for VISIBILITY only — their rows never count
// against the autonomous caps (which are sized for loop items, not chat
// turns). Mirrors orchestratorHero scripts/usage_governor.py
// INTERACTIVE_COMPONENTS; invariant 81-governor-lane-mirror.py enforces the
// two sets stay identical.
const INTERACTIVE_COMPONENTS = new Set(["llmterminal-chat"]);

// Append one claude call to the shared ledger. Same row schema as the python
// governor (epoch-seconds ts, iso, component, model, cost_usd, meta<=120ch).
// Never throws — a ledger hiccup must not take down a chat turn.
function record(component, model, costUsd, meta) {
  try {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    const row = {
      ts: Date.now() / 1000,
      iso: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
      component: String(component || "llmterminal"),
      model: String(model || "unknown"),
      cost_usd: Math.round((Number(costUsd) || 0) * 1e6) / 1e6,
    };
    if (meta) row.meta = String(meta).slice(0, 120);
    fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  } catch (e) {
    console.error("[governor] record failed:", e.message);
  }
}

// (spend_usd, call_count) within the trailing window. Never throws.
// lane "autonomous" (the gate's view) excludes INTERACTIVE_COMPONENTS;
// "interactive" counts only them; "all" counts everything.
function _window(hours, lane = "autonomous") {
  const cutoff = Date.now() / 1000 - hours * 3600;
  let spend = 0, calls = 0;
  try {
    const lines = fs.readFileSync(LEDGER, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if ((Number(row.ts) || 0) < cutoff) continue;
      const isInteractive = INTERACTIVE_COMPONENTS.has(String(row.component || ""));
      if (lane === "autonomous" && isInteractive) continue;
      if (lane === "interactive" && !isInteractive) continue;
      spend += Number(row.cost_usd) || 0;
      calls += 1;
    }
  } catch {} // missing ledger = zero spend
  return { spend, calls };
}

// Seconds left on the shared provider-limit cooldown (python's
// record_limit_hit writes it when any component sees a limit error).
function _cooldownRemaining() {
  try {
    const state = JSON.parse(fs.readFileSync(LIMIT_STATE, "utf8"));
    return Math.max(0, (Number(state.cooldown_until) || 0) - Date.now() / 1000);
  } catch { return 0; }
}

// Gate: call BEFORE any machine-initiated claude spawn. {ok, reason}.
// Interactive paths must NOT call this — they record() only.
function check(component) {
  const remaining = _cooldownRemaining();
  if (remaining > 0) {
    return { ok: false, reason: "provider-limit cooldown active for " + Math.round(remaining / 60) + " more min (see limit_state.json)" };
  }
  const hour = _window(1);
  if (hour.spend >= HOURLY_USD) {
    return { ok: false, reason: "hourly spend cap: $" + hour.spend.toFixed(2) + " >= $" + HOURLY_USD.toFixed(2) + " (resumes as window rolls)" };
  }
  if (hour.calls >= CALLS_PER_HOUR) {
    return { ok: false, reason: "hourly call cap: " + hour.calls + " >= " + CALLS_PER_HOUR };
  }
  const day = _window(24);
  if (day.spend >= DAILY_USD) {
    return { ok: false, reason: "daily spend cap: $" + day.spend.toFixed(2) + " >= $" + DAILY_USD.toFixed(2) };
  }
  return { ok: true, reason: "" };
}

function status() {
  const hour = _window(1);
  const day = _window(24);
  const iHour = _window(1, "interactive");
  const iDay = _window(24, "interactive");
  return {
    // hour/day = the AUTONOMOUS lane (what check() gates on)
    hour: { spend_usd: Math.round(hour.spend * 100) / 100, calls: hour.calls, caps: { usd: HOURLY_USD, calls: CALLS_PER_HOUR } },
    day: { spend_usd: Math.round(day.spend * 100) / 100, calls: day.calls, caps: { usd: DAILY_USD } },
    // visibility-only lane; never gates (see INTERACTIVE_COMPONENTS)
    interactive: {
      hour: { spend_usd: Math.round(iHour.spend * 100) / 100, calls: iHour.calls },
      day: { spend_usd: Math.round(iDay.spend * 100) / 100, calls: iDay.calls },
    },
    cooldown_remaining_s: Math.round(_cooldownRemaining()),
    ledger: LEDGER,
  };
}

module.exports = { check, record, status, LEDGER, LIMIT_STATE };

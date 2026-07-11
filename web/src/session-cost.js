// Per-chat cost rollup (2026-07-11, David: "a specific number as to how much
// money was spent" on every chat — accurate, provider-aware).
//
// Reads the shared spend ledger (see governor.js) and answers for ONE
// llmTerminal session:
//   api_usd   — real billed dollars (OpenAI / Google API keys)
//   plan_usd  — Claude Max plan turns: LIST-PRICE EQUIVALENT the CLI reports;
//               the marginal cost to David is $0 (included in the plan)
//   downstream — spend by orchestrator queue items this chat originated
//               (origin_session attribution; claude CLI runs = plan billing)
//
// Matching: new rows carry the full `session` id; legacy rows (pre 2026-07-11)
// only have the 8-char prefix in `meta` and were all Claude turns → plan.
// Accuracy notes are returned, not hidden: unpriced API calls (model missing
// from pricing.js) are counted and flagged.
const fs = require("fs");
const { LEDGER } = require("./governor");

const ORCH_BASE = process.env.ORCH_BASE || "http://127.0.0.1:8000";

// Flat monthly price of the Claude Max plan — the ONLY real dollars Claude
// costs. Per-chat Claude numbers are this bill apportioned by actual usage
// weight; the CLI's list-price equivalents are used ONLY as internal weights
// and never shown as spend (David 2026-07-11: "give me the actuals").
const MAX_PLAN_USD_MONTH = parseFloat(process.env.MAX_PLAN_USD_MONTH || "200");

function _month(row) {
  return String(row.iso || "").slice(0, 7) || "unknown"; // YYYY-MM
}

function _scanLedger(sessionId) {
  const out = {
    api_usd: 0, calls: 0, unpriced_calls: 0,
    tokens_in: 0, tokens_out: 0,
    plan_weight_by_month: {},   // this session's usage weight per YYYY-MM
    plan_total_by_month: {},    // ALL plan usage on the box per YYYY-MM
  };
  let text = "";
  try { text = fs.readFileSync(LEDGER, "utf8"); } catch { return out; }
  const prefix = String(sessionId).slice(0, 8);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const isApi = row.billing === "api";
    if (!isApi) {
      // every plan row on the box contributes to the month's denominator
      const m = _month(row);
      out.plan_total_by_month[m] = (out.plan_total_by_month[m] || 0) + (Number(row.cost_usd) || 0);
    }
    const matches = row.session
      ? row.session === sessionId
      : (String(row.component || "").startsWith("llmterminal") && row.meta === prefix);
    if (!matches) continue;
    out.calls += 1;
    if (row.unpriced) out.unpriced_calls += 1;
    if (isApi) out.api_usd += Number(row.cost_usd) || 0;
    else {
      const m = _month(row);
      out.plan_weight_by_month[m] = (out.plan_weight_by_month[m] || 0) + (Number(row.cost_usd) || 0);
    }
    out.tokens_in += Number(row.tokens_in) || 0;
    out.tokens_out += Number(row.tokens_out) || 0;
  }
  return out;
}

// Apportion the flat monthly bill: for each month the session was active,
// its share = (its plan weight / the month's total plan weight) × $bill.
// Sums to exactly the bill across all sessions — actual dollars, allocated.
function _planShare(weightByMonth, totalByMonth, downWeightByMonth) {
  let share = 0;
  let fractionLatest = 0;
  const months = new Set([...Object.keys(weightByMonth), ...Object.keys(downWeightByMonth || {})]);
  for (const m of months) {
    const mine = (weightByMonth[m] || 0) + ((downWeightByMonth || {})[m] || 0);
    const total = totalByMonth[m] || 0;
    if (total > 0 && mine > 0) {
      const frac = Math.min(1, mine / total);
      share += frac * MAX_PLAN_USD_MONTH;
      fractionLatest = frac;
    }
  }
  return { share, fractionLatest };
}

// Queue items this chat originated → their execution runs' cost. Requires the
// orchestrator backend to support ?origin_session (absent-safe: zeros).
async function _downstream(sessionId) {
  const out = { plan_weight_by_month: {}, items: 0, runs: 0, available: false };
  try {
    const r = await fetch(
      `${ORCH_BASE}/api/orchestrator/queue/items?origin_session=${encodeURIComponent(sessionId)}&limit=100`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!r.ok) return out;
    const items = (await r.json()).items || [];
    out.available = true;
    out.items = items.length;
    for (const item of items) {
      try {
        const rr = await fetch(
          `${ORCH_BASE}/api/orchestrator/queue/items/${item.task_id}/runs`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (!rr.ok) continue;
        for (const run of (await rr.json()).runs || []) {
          const m = String(run.created_at || run.started_at || "").slice(0, 7) || "unknown";
          out.plan_weight_by_month[m] = (out.plan_weight_by_month[m] || 0) + (Number(run.cost_usd) || 0);
          out.runs += 1;
        }
      } catch {}
    }
  } catch {}
  return out;
}

async function sessionCost(sessionId) {
  const own = _scanLedger(sessionId);
  const down = await _downstream(sessionId);
  let org = null;
  try { org = await require("./claude-billing").claudeBilling(); } catch {}
  const r2 = (n) => Math.round(n * 100) / 100;
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const plan = _planShare(own.plan_weight_by_month, own.plan_total_by_month, down.plan_weight_by_month);
  return {
    session: sessionId,
    // ACTUAL dollars only:
    api_usd: r6(own.api_usd),                     // billed on the OpenAI/Google keys
    plan_share_usd: r2(plan.share),               // this chat's slice of the flat Max bill
    plan_month_bill_usd: MAX_PLAN_USD_MONTH,
    plan_usage_fraction: Math.round(plan.fractionLatest * 1000) / 10, // % of this month's plan usage
    calls: own.calls,
    downstream: { items: down.items, runs: down.runs, available: down.available },
    // Console-true org numbers (same as claude.ai Settings→Usage):
    anthropic_console: org && org.available ? {
      overage_used_usd: org.overage_used_usd,
      overage_limit_usd: org.overage_limit_usd,
      session_pct: org.session_pct,
      weekly_pct: org.weekly_pct,
      fetched_at: org.fetched_at,
    } : { available: false, reason: org ? org.reason : "unavailable" },
    notes: [
      `Claude runs on the Max plan: a flat $${MAX_PLAN_USD_MONTH}/mo regardless of usage. ` +
        "plan_share_usd = this chat's slice of that actual bill, weighted by its share of the month's total plan usage.",
      "api_usd = real billed dollars on the OpenAI/Google keys.",
      ...(org && org.available
        ? [`Anthropic console (live): $${org.overage_used_usd.toFixed(2)} usage credits spent of $${org.overage_limit_usd.toFixed(0)} this month — real overage dollars ON TOP of the subscription (org-wide; Anthropic does not expose per-chat overage).`]
        : []),
      ...(own.unpriced_calls
        ? [`${own.unpriced_calls} API call(s) have no rate in pricing.js — tokens counted, dollars unknown`]
        : []),
      ...(down.available ? [] : ["downstream attribution unavailable (orchestrator backend lacks origin_session support or is down)"]),
    ],
  };
}

module.exports = { sessionCost };

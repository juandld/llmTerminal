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

function _scanLedger(sessionId) {
  const out = {
    api_usd: 0, plan_usd: 0, calls: 0, unpriced_calls: 0,
    tokens_in: 0, tokens_out: 0,
  };
  let text = "";
  try { text = fs.readFileSync(LEDGER, "utf8"); } catch { return out; }
  const prefix = String(sessionId).slice(0, 8);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const matches = row.session
      ? row.session === sessionId
      : (String(row.component || "").startsWith("llmterminal") && row.meta === prefix);
    if (!matches) continue;
    out.calls += 1;
    if (row.unpriced) out.unpriced_calls += 1;
    if (row.billing === "api") out.api_usd += Number(row.cost_usd) || 0;
    else out.plan_usd += Number(row.cost_usd) || 0; // legacy = claude = plan
    out.tokens_in += Number(row.tokens_in) || 0;
    out.tokens_out += Number(row.tokens_out) || 0;
  }
  return out;
}

// Queue items this chat originated → their execution runs' cost. Requires the
// orchestrator backend to support ?origin_session (absent-safe: zeros).
async function _downstream(sessionId) {
  const out = { plan_usd: 0, items: 0, runs: 0, available: false };
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
          out.plan_usd += Number(run.cost_usd) || 0; // supervisor runs = claude CLI = plan
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
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  return {
    session: sessionId,
    api_usd: r6(own.api_usd),
    plan_usd: r6(own.plan_usd + down.plan_usd),
    own: { ...own, api_usd: r6(own.api_usd), plan_usd: r6(own.plan_usd) },
    downstream: { ...down, plan_usd: r6(down.plan_usd) },
    notes: [
      "plan_usd = Claude Max list-price equivalent (included in the plan, not billed)",
      "api_usd = real dollars on the OpenAI/Google keys",
      ...(own.unpriced_calls
        ? [`${own.unpriced_calls} API call(s) have no rate in pricing.js — tokens counted, dollars unknown`]
        : []),
      ...(down.available ? [] : ["downstream attribution unavailable (orchestrator backend lacks origin_session support or is down)"]),
    ],
  };
}

module.exports = { sessionCost };

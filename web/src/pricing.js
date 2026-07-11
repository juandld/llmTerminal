// API price table for per-chat cost accounting (2026-07-11).
//
// ONLY the API-key providers live here (OpenAI, Google) — their tokens are
// real billed dollars. Claude is on the Max PLAN: its turns record the CLI's
// list-price equivalent with billing:"plan" and never touch this table.
//
// Rates are USD per MILLION tokens, {in, out}. Longest-prefix match so dated
// snapshots inherit their family's rate. A model with no entry (or a null
// entry) records tokens with unpriced:true instead of inventing a number —
// accuracy means saying "unknown", not guessing. Update this table when
// OpenAI/Google reprice; it is deliberately the ONLY place rates exist.
//
// Sources: provider pricing pages as of the date above. gpt-5.x / gemini-3.x
// entries are set where David's account pricing is confirmed; otherwise null.

const OPENAI_MTOK = {
  "gpt-4o-mini": { in: 0.15, out: 0.60 },
  "gpt-4o": { in: 2.50, out: 10.00 },
  "gpt-4.1-nano": { in: 0.10, out: 0.40 },
  "gpt-4.1-mini": { in: 0.40, out: 1.60 },
  "gpt-4.1": { in: 2.00, out: 8.00 },
  "o3-mini": { in: 1.10, out: 4.40 },
  "o4-mini": { in: 1.10, out: 4.40 },
  "o3": { in: 2.00, out: 8.00 },
  // Post-2025 families — confirm against the account's pricing page, then fill:
  "gpt-5.1": null,
  "gpt-5.2": null,
  "gpt-5.3": null,
  "gpt-5.4": null,
  "gpt-5.5": null,
  "gpt-5.6": null,
};

const GOOGLE_MTOK = {
  "gemini-2.0-flash-lite": { in: 0.075, out: 0.30 },
  "gemini-2.0-flash": { in: 0.10, out: 0.40 },
  "gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  "gemini-2.5-pro": { in: 1.25, out: 10.00 }, // ≤200k-token prompts
  "gemini-3.1-pro": null,
  "gemini-3.5-flash": null,
  "gemini-3-pro": null,
};

function _lookup(table, modelId) {
  const id = String(modelId || "").toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const [prefix, rate] of Object.entries(table)) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = rate;
      bestLen = prefix.length;
    }
  }
  return best; // null = known-but-unpriced OR no match at all
}

// → { cost_usd, unpriced } — cost_usd is null when the rate is unknown.
function priceTokens(provider, modelId, tokensIn, tokensOut) {
  const table = provider === "openai" ? OPENAI_MTOK : provider === "google" ? GOOGLE_MTOK : null;
  const rate = table ? _lookup(table, modelId) : null;
  if (!rate) return { cost_usd: null, unpriced: true };
  const cost = (Number(tokensIn) || 0) * rate.in / 1e6 + (Number(tokensOut) || 0) * rate.out / 1e6;
  return { cost_usd: Math.round(cost * 1e6) / 1e6, unpriced: false };
}

module.exports = { priceTokens };

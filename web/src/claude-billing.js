// ACTUAL Claude billing numbers, straight from David's claude.ai account
// (2026-07-11). Reads the same JSON endpoints the console's Usage page uses:
//   /api/organizations/{org}/overage_spend_limit  → usage credits: used/limit (cents)
//   /api/organizations/{org}/usage                → 5h/7d plan-limit utilization %
// via the ORCHESTRATORHERO chromium profile, where a claude.ai session for
// david@crankwheel.com is persisted (logged in via emailed magic link,
// 2026-07-11 — see the per-chat cost thread). No scraping, no DOM: same-origin
// fetches in a throwaway tab, closed immediately. Cached 10 minutes.
//
// If the session ever expires the result carries available:false and
// reason:"login-expired" — re-run the magic-link login (claude.ai login →
// email code to david@crankwheel.com → camoHero Gmail bridge reads the link).
const fs = require("fs");
const path = require("path");

const PW_CORE = "/home/claude-user/.claude/mcp-servers/playwright/node_modules/playwright-core";
const PROJECTS_JSON = path.join(__dirname, "..", "config", "projects.json");

function _cdpPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(PROJECTS_JSON, "utf8"));
    const p = (cfg.projects || []).find((x) => x.slug === "orchestratorhero");
    if (p && p.cdp_port) return p.cdp_port;
  } catch {}
  return 9225;
}

let _cache = null;
let _cacheTs = 0;
let _inflight = null;
const TTL_MS = 10 * 60 * 1000;

async function _fetchLive() {
  const { chromium } = require(PW_CORE);
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${_cdpPort()}`, { timeout: 5000 });
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    try {
      await page.goto("https://claude.ai/api/organizations", { timeout: 20000, waitUntil: "domcontentloaded" });
      const orgsText = await page.evaluate(() => document.body.innerText);
      let orgs;
      try { orgs = JSON.parse(orgsText); } catch { orgs = null; }
      if (!Array.isArray(orgs) || !orgs[0] || !orgs[0].uuid) {
        return { available: false, reason: "login-expired" };
      }
      const org = orgs[0].uuid;
      const data = await page.evaluate(async (orgUuid) => {
        const get = async (p) => {
          const r = await fetch(p, { credentials: "include" });
          return r.ok ? r.json() : null;
        };
        return {
          overage: await get(`/api/organizations/${orgUuid}/overage_spend_limit`),
          usage: await get(`/api/organizations/${orgUuid}/usage`),
        };
      }, org);
      const ov = data.overage || {};
      const us = data.usage || {};
      return {
        available: true,
        fetched_at: new Date().toISOString(),
        org_uuid: org,
        // Usage credits = the ONLY metered real dollars on the Max plan.
        overage_used_usd: (Number(ov.used_credits) || 0) / 100,
        overage_limit_usd: (Number(ov.monthly_credit_limit) || 0) / 100,
        overage_enabled: !!ov.is_enabled,
        session_pct: us.five_hour ? Number(us.five_hour.utilization) || 0 : null,
        session_resets_at: us.five_hour ? us.five_hour.resets_at : null,
        weekly_pct: us.seven_day ? Number(us.seven_day.utilization) || 0 : null,
        weekly_resets_at: us.seven_day ? us.seven_day.resets_at : null,
      };
    } finally {
      try { await page.close(); } catch {}
      try { await browser.close(); } catch {}
    }
  } catch (e) {
    try { if (browser) await browser.close(); } catch {}
    return { available: false, reason: String(e.message || e).slice(0, 120) };
  }
}

async function claudeBilling() {
  const now = Date.now();
  if (_cache && now - _cacheTs < TTL_MS) return _cache;
  if (_inflight) return _inflight;
  _inflight = _fetchLive().then((r) => {
    if (r && r.available) { _cache = r; _cacheTs = Date.now(); }
    _inflight = null;
    return r;
  }).catch((e) => { _inflight = null; return { available: false, reason: String(e).slice(0, 120) }; });
  return _inflight;
}

module.exports = { claudeBilling };

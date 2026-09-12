#!/usr/bin/env node
// Backfill the correction ledger by replaying historical user messages through
// the LIVE server's extractor (POST /api/sessions/:id/corrections/extract), so
// all writes go through the server's single sqlite handle. Paced so the
// cheap-model throttle/governor never sees a burst. Idempotent: the ledger's
// UNIQUE (session_id, user_ts) index turns re-runs into no-ops.
//
//   node scripts/backfill-corrections.js [--days 7] [--sessions id,id,...]
//                                       [--pace-ms 6000] [--max-per-session 25]
const fs = require("fs");
const path = require("path");
const BASE = process.env.LLMT_BASE || "http://127.0.0.1:7683";
const HOME = process.env.HOME || "/home/claude-user";
const SESSIONS = path.join(HOME, ".llm-terminal", "sessions.json");
const MESSAGES = path.join(HOME, ".llm-terminal", "messages");

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const DAYS = Number(opt("--days", 7));
const ONLY = (opt("--sessions", "") || "").split(",").map(s => s.trim()).filter(Boolean);
const PACE = Number(opt("--pace-ms", 6000));
const MAX_PER = Number(opt("--max-per-session", 25));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " -> " + r.status); return r.json(); }
async function postJson(u, body) {
  const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(u + " -> " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}
async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { await getJson(BASE + "/api/corrections?limit=1"); return; } catch {}
    await sleep(2000);
  }
  throw new Error("server never became healthy at " + BASE);
}

(async () => {
  await waitHealthy();
  const all = JSON.parse(fs.readFileSync(SESSIONS, "utf8"));
  const newest = Math.max(...all.map(s => Number(s.created) || 0));
  let sessions = ONLY.length
    ? all.filter(s => ONLY.some(p => s.id.startsWith(p)))
    : all.filter(s => Number(s.created) && newest - Number(s.created) <= DAYS * 86400000);
  const plan = [];
  for (const s of sessions) {
    const f = path.join(MESSAGES, s.id + ".json");
    if (!fs.existsSync(f)) continue;
    let msgs; try { msgs = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    const idxs = [];
    msgs.forEach((m, i) => { if (m.role === "user" && m.source !== "wake" && String(m.text || "").trim()) idxs.push(i); });
    for (const i of idxs.slice(1, 1 + MAX_PER)) plan.push({ id: s.id, project: s.project, userIdx: i });
  }
  const before = (await getJson(BASE + "/api/corrections?days=3650&limit=1000")).count;
  console.log(`sessions=${sessions.length} candidates=${plan.length} pace=${PACE}ms ledger_before=${before}`);
  let fired = 0, failed = 0;
  for (const p of plan) {
    try { await postJson(`${BASE}/api/sessions/${p.id}/corrections/extract`, { userIdx: p.userIdx }); fired++; }
    catch (e) { failed++; console.warn("extract failed", p.id.slice(0, 8), p.userIdx, e.message); }
    await sleep(PACE);
  }
  console.log(`fired=${fired} failed=${failed}; waiting 75s for stragglers…`);
  await sleep(75000);
  const after = await getJson(BASE + "/api/corrections?days=3650&limit=1000");
  console.log(`ledger_after=${after.count} (+${after.count - before})`);
  console.log("by_class:");
  for (const b of after.by_class) console.log(`  ${b.class.padEnd(16)} ${String(b.count).padStart(3)}  high=${b.high}  projects=${JSON.stringify(b.projects)}`);
})().catch(e => { console.error("backfill failed:", e.message); process.exit(1); });

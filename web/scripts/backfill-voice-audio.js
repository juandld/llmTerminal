#!/usr/bin/env node
// One-off backfill (2026-06-12): voice-note user messages saved before the
// audioUrl-persistence fix have no audioUrl, so the history voice bubble can't
// offer playback. Recover the link from file_attribution.jsonl, which records
// {path, session_id, ts} for every voice-note upload — att.ts lands within
// ~100ms of the queued message ts (same request handler, ms apart).
// Idempotent: rows that already have an audioUrl are skipped.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = "/home/claude-user/.llm-terminal";
const MATCH_WINDOW_MS = 30_000;

const attribution = fs.readFileSync(path.join(DATA_DIR, "file_attribution.jsonl"), "utf8")
  .split("\n").filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(r => r && r.tool === "voice-note" && r.path && r.session_id && r.ts && fs.existsSync(r.path));

const db = new DatabaseSync(path.join(DATA_DIR, "messages.db"));
db.exec("PRAGMA busy_timeout=5000");

const rows = db.prepare("SELECT id, session_id, ts, data FROM messages WHERE role='user'").all();
const candidates = [];
for (const r of rows) {
  let d; try { d = JSON.parse(r.data); } catch { continue; }
  if (d.source === "voice-note" && !d.audioUrl) candidates.push({ ...r, parsed: d });
}

const usedAtt = new Set();
const patchedBySession = new Map(); // session_id -> [{ts, audioUrl}]
const upd = db.prepare("UPDATE messages SET data=? WHERE id=?");
let patched = 0;

for (const c of candidates) {
  let best = null, bestDelta = Infinity;
  for (let i = 0; i < attribution.length; i++) {
    if (usedAtt.has(i)) continue;
    const a = attribution[i];
    if (a.session_id !== c.session_id) continue;
    const delta = Math.abs(a.ts - c.ts);
    if (delta < bestDelta) { bestDelta = delta; best = i; }
  }
  if (best === null || bestDelta > MATCH_WINDOW_MS) {
    console.log(`no match (Δ${bestDelta === Infinity ? "∞" : bestDelta + "ms"}): msg ${c.id} "${(c.parsed.text || "").slice(0, 40)}"`);
    continue;
  }
  usedAtt.add(best);
  const audioUrl = "/voice-notes/" + path.basename(attribution[best].path);
  c.parsed.audioUrl = audioUrl;
  upd.run(JSON.stringify(c.parsed), c.id);
  if (!patchedBySession.has(c.session_id)) patchedBySession.set(c.session_id, []);
  patchedBySession.get(c.session_id).push({ ts: c.parsed.ts, audioUrl });
  patched++;
  console.log(`msg ${c.id} (Δ${bestDelta}ms) -> ${audioUrl}`);
}
db.close();

// Patch the JSON mirrors so cat-level inspection matches the db
for (const [sid, patches] of patchedBySession) {
  const p = path.join(DATA_DIR, "messages", sid + ".json");
  let arr; try { arr = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
  let n = 0;
  for (const m of arr) {
    if (m.role !== "user" || m.source !== "voice-note" || m.audioUrl) continue;
    const hit = patches.find(x => x.ts === m.ts);
    if (hit) { m.audioUrl = hit.audioUrl; n++; }
  }
  if (n) { fs.writeFileSync(p, JSON.stringify(arr)); console.log(`mirror ${sid}: ${n} patched`); }
}
console.log(`done: ${patched} rows backfilled, ${candidates.length - patched} unmatched`);

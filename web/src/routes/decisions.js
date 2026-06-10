// Decision timeline/tree API (David's decisions framework). Extracted from
// server.js (refactor 2026-06-10, phase 11). Read/writes the `decisions` table.
const express = require("express");
const { db, loadSessions } = require("../store");

function _arrText(x) {
  if (Array.isArray(x)) return JSON.stringify(x);
  if (typeof x === "string") return x;
  return null;
}
function _normalizeDecisionRow(row) {
  if (!row) return null;
  let alts, cons, arts;
  try { alts = row.alternatives ? JSON.parse(row.alternatives) : []; } catch { alts = []; }
  try { cons = row.constraints ? JSON.parse(row.constraints) : []; } catch { cons = []; }
  try { arts = row.artifacts ? JSON.parse(row.artifacts) : null; } catch { arts = null; }
  return {
    id: row.id,
    session_id: row.session_id,
    parent_id: row.parent_id,
    ts: row.ts,
    summary: row.summary,
    chose: row.chose,
    alternatives: alts,
    why: row.why,
    constraints: cons,
    cost: row.cost,
    status: row.status,
    artifacts: arts,
    mined: !!row.mined,
  };
}

module.exports = function mountDecisions(app) {
  app.post("/api/sessions/:id/decisions", express.json(), (req, res) => {
    const id = req.params.id;
    if (!db) return res.status(503).json({ ok: false, error: "db unavailable" });
    const summary = String(req.body?.summary || "").trim();
    const chose   = String(req.body?.chose   || "").trim();
    if (!summary || !chose) {
      return res.status(400).json({ ok: false, error: "summary and chose are required" });
    }
    const why   = String(req.body?.why   || "").trim() || null;
    const cost  = String(req.body?.cost  || "").trim() || null;
    const alts  = _arrText(req.body?.alternatives) || null;
    const cons  = _arrText(req.body?.constraints)  || null;
    let parentId = req.body?.parent_id;
    // If unspecified, link to the most recent decision in this session.
    if (parentId === undefined || parentId === null) {
      try {
        const last = db.prepare("SELECT id FROM decisions WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1").get(id);
        parentId = last ? last.id : null;
      } catch { parentId = null; }
    } else {
      parentId = Number(parentId) || null;
    }
    const ts = Date.now();
    const mined = req.body?.mined ? 1 : 0;
    try {
      const result = db
        .prepare("INSERT INTO decisions (session_id, parent_id, ts, summary, chose, alternatives, why, constraints, cost, status, artifacts, mined) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)")
        .run(id, parentId, ts, summary, chose, alts, why, cons, cost, mined);
      const newId = Number(result.lastInsertRowid);
      const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(newId);
      res.json({ ok: true, decision: _normalizeDecisionRow(row) });
    } catch (e) {
      console.error("[decisions] insert failed:", e.message);
      res.status(500).json({ ok: false, error: "insert failed" });
    }
  });

  app.post("/api/decisions/:did/status", express.json(), (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: "db unavailable" });
    const did = Number(req.params.did);
    const status = String(req.body?.status || "").trim();
    const ALLOWED = new Set(["pending", "verified", "reversed", "mined"]);
    if (!ALLOWED.has(status)) {
      return res.status(400).json({ ok: false, error: "status must be one of " + [...ALLOWED].join("|") });
    }
    const artifact = req.body?.artifact;
    try {
      const existing = db.prepare("SELECT artifacts FROM decisions WHERE id = ?").get(did);
      if (!existing) return res.status(404).json({ ok: false, error: "decision not found" });
      let merged = null;
      if (artifact !== undefined && artifact !== null) {
        let obj;
        try { obj = existing.artifacts ? JSON.parse(existing.artifacts) : {}; } catch { obj = {}; }
        if (typeof artifact === "string") {
          const arr = Array.isArray(obj.notes) ? obj.notes : [];
          arr.push(artifact);
          obj.notes = arr;
        } else if (typeof artifact === "object") {
          Object.assign(obj, artifact);
        }
        merged = JSON.stringify(obj);
      }
      if (merged !== null) {
        db.prepare("UPDATE decisions SET status = ?, artifacts = ? WHERE id = ?").run(status, merged, did);
      } else {
        db.prepare("UPDATE decisions SET status = ? WHERE id = ?").run(status, did);
      }
      const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(did);
      res.json({ ok: true, decision: _normalizeDecisionRow(row) });
    } catch (e) {
      console.error("[decisions] update failed:", e.message);
      res.status(500).json({ ok: false, error: "update failed" });
    }
  });

  app.get("/api/sessions/:id/decisions", (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: "db unavailable" });
    try {
      const rows = db.prepare("SELECT * FROM decisions WHERE session_id = ? ORDER BY ts ASC, id ASC").all(req.params.id);
      res.json({ decisions: rows.map(_normalizeDecisionRow) });
    } catch (e) {
      res.status(500).json({ ok: false, error: "query failed" });
    }
  });

  app.get("/api/projects/:name/decisions", (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: "db unavailable" });
    try {
      // Sessions belong to projects via sessions.json — get all session ids for this project,
      // then fetch their decisions ordered globally.
      const sessions = loadSessions().filter(s => s.project === req.params.name);
      if (!sessions.length) return res.json({ decisions: [] });
      const idList = sessions.map(s => s.id);
      const placeholders = idList.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT * FROM decisions WHERE session_id IN (${placeholders}) ORDER BY ts ASC, id ASC`)
        .all(...idList);
      res.json({ decisions: rows.map(_normalizeDecisionRow) });
    } catch (e) {
      res.status(500).json({ ok: false, error: "query failed" });
    }
  });

  // ---- TTS proxy to OpenAI with disk cache ----
};

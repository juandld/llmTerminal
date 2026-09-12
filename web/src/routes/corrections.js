// Correction ledger API (H9 correction reflex). Read side for the weekly
// chat-quality audit + a future drawer; status side so a correction can be
// marked guarded (with the invariant/commit/queue item that closed it) or
// dismissed. Extraction is triggered by supervisors.spawnCorrectionExtractor
// after every run; the POST .../extract route exists for backfills only.
const express = require("express");
const corrections = require("../corrections");
const { loadSessions } = require("../store");

module.exports = function mountCorrections(app) {
  app.get("/api/corrections", (req, res) => {
    try {
      const q = req.query || {};
      const opts = {
        project: q.project ? String(q.project) : null,
        cls: q.class ? String(q.class) : null,
        status: q.status ? String(q.status) : null,
        days: q.days ? Number(q.days) : null,
        limit: q.limit ? Number(q.limit) : 200,
      };
      const rows = corrections.listCorrections(opts);
      res.json({ corrections: rows, by_class: corrections.summarizeByClass(opts), count: rows.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: "query failed: " + e.message });
    }
  });

  app.get("/api/sessions/:id/corrections", (req, res) => {
    try {
      res.json({ corrections: corrections.listCorrections({ sessionId: req.params.id, limit: 500 }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: "query failed" });
    }
  });

  app.post("/api/corrections/:id/status", express.json(), (req, res) => {
    try {
      const id = Number(req.params.id);
      const status = String((req.body && req.body.status) || "");
      if (!Number.isInteger(id) || !corrections.STATUSES.includes(status)) {
        return res.status(400).json({ ok: false, error: "id + status (" + corrections.STATUSES.join("|") + ") required" });
      }
      const row = corrections.setStatus(id, status, req.body.artifact ? String(req.body.artifact) : null);
      if (!row) return res.status(404).json({ ok: false, error: "not found" });
      res.json({ ok: true, correction: row });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // What the next turn in this session/project will see. Verification aid.
  app.get("/api/corrections/prompt-preview", (req, res) => {
    const q = req.query || {};
    const sessionId = q.sessionId ? String(q.sessionId) : null;
    let project = q.project ? String(q.project) : null;
    if (!project && sessionId) {
      const s = loadSessions().find(x => x.id === sessionId);
      project = s ? s.project : null;
    }
    res.json({ project, sessionId, block: corrections.buildPromptAdd(sessionId, project) });
  });

  // Backfill hook: classify a specific historical user message (by index in
  // the session transcript). Fire-and-forget; poll /api/corrections after.
  app.post("/api/sessions/:id/corrections/extract", express.json(), (req, res) => {
    try {
      const { spawnCorrectionExtractor } = require("../supervisors");
      const s = loadSessions().find(x => x.id === req.params.id);
      if (!s) return res.status(404).json({ ok: false, error: "session not found" });
      const userIdx = Number(req.body && req.body.userIdx);
      spawnCorrectionExtractor(s.id, s.project, Number.isInteger(userIdx) ? { userIdx } : {});
      res.json({ ok: true, queued: true, sessionId: s.id, project: s.project, userIdx: Number.isInteger(userIdx) ? userIdx : null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};

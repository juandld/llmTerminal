// jobs.js — the jobs ledger. One JSON file per long-running job under
// ~/.llm-terminal/jobs/, plus an append-only events log. ONE substrate, two
// consumers: the operator's glass-box Jobs view AND the orchestrator's worker
// tracking (ARCHITECTURE.md §4 continuity / ORCHESTRATOR-PLAN continuity substrate).
// Schema is orchestrator-grade: parent (fan-of-workers), result_path (merge),
// last_beat+beat_interval (provable liveness), reversible (the §7 gate).
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const JOBS_DIR = path.join(DATA_DIR, "jobs");
const EVENTS_LOG = path.join(JOBS_DIR, "events.jsonl");
fs.mkdirSync(JOBS_DIR, { recursive: true });

const _file = id => path.join(JOBS_DIR, String(id).replace(/[^a-zA-Z0-9_.-]/g, "_") + ".json");
function _emit(ev) { try { fs.appendFileSync(EVENTS_LOG, JSON.stringify(ev) + "\n"); } catch {} }
function _write(j) { j.updated_at = Date.now(); try { fs.writeFileSync(_file(j.id), JSON.stringify(j)); } catch {} }
function readJob(id) { try { return JSON.parse(fs.readFileSync(_file(id), "utf8")); } catch { return null; } }

function startJob({ id, label, kind = "task", parent = null, total = null, log_path = null, beat_interval_ms = 60000, reversible = true }) {
  const j = { id, label: label || id, kind, parent, status: "running", progress: total ? "0/" + total : "",
    done: 0, total, started_at: Date.now(), last_beat: Date.now(), ended_at: null,
    beat_interval_ms, result_path: null, reversible, log_path, note: "" };
  _write(j); _emit({ ts: Date.now(), id: j.id, event: "start", label: j.label, kind, parent });
  return j;
}
function beatJob(id, { progress = null, done = null, note = null } = {}) {
  const j = readJob(id); if (!j) return;
  j.last_beat = Date.now();
  if (done != null) { j.done = done; if (j.total) j.progress = done + "/" + j.total; }
  if (progress != null) j.progress = progress;
  if (note != null) j.note = note;
  _write(j);
}
function endJob(id, status, { note = null, result_path = null } = {}) {
  const j = readJob(id); if (!j) return;
  j.status = status; j.ended_at = Date.now(); j.last_beat = Date.now();
  if (note != null) j.note = note; if (result_path != null) j.result_path = result_path;
  _write(j); _emit({ ts: Date.now(), id, event: status, label: j.label, parent: j.parent, note });
}
function _liveness(j) {
  if (j.status === "running" && Date.now() - j.last_beat > (j.beat_interval_ms || 60000) * 2) j.status = "stalled";
  return j;
}
function listJobs() {
  let files = []; try { files = fs.readdirSync(JOBS_DIR).filter(f => f.endsWith(".json")); } catch {}
  return files.map(f => { try { return _liveness(JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8"))); } catch { return null; } })
    .filter(Boolean).sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
}
// Persist newly-stalled jobs + emit an event so the orchestrator can react (retry/escalate)
// instead of a worker dying into silence. This is the anti-silent-hang.
function sweepStalled() {
  for (const j of listJobs()) {
    if (j.status === "stalled") {
      const disk = readJob(j.id);
      if (disk && disk.status === "running") { disk.status = "stalled"; _write(disk); _emit({ ts: Date.now(), id: j.id, event: "stalled", label: j.label, parent: j.parent }); }
    }
  }
}
module.exports = { JOBS_DIR, EVENTS_LOG, startJob, beatJob, endJob, readJob, listJobs, sweepStalled };

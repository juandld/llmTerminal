// Leak instrumentation for llmTerminal (added 2026-07-24 to trace the node RSS
// climb that throttles the service every ~1 day). Non-invasive: samples memory
// on a timer, appends JSONL, and dumps a heap snapshot when RSS crosses tunable
// thresholds so we can diff retainers in Chrome DevTools. Remove once the leak
// is fixed. Toggle off with LEAK_TRACE=0.
const fs = require("fs");
const path = require("path");
const v8 = require("v8");

const DATA_DIR = process.env.LLMT_DATA_DIR || "/home/claude-user/.llm-terminal";
const TRACE_PATH = path.join(DATA_DIR, "leak-trace.jsonl");
const SAMPLE_MS = parseInt(process.env.LEAK_TRACE_SAMPLE_MS || "30000", 10);
// RSS thresholds (bytes) that each trigger ONE heap snapshot. Two points let us
// diff early-vs-late to see what grew. Kept under MemoryMax(8G) with headroom so
// writing the snapshot can't OOM us. Tune via LEAK_TRACE_SNAP_GB="3,4.5".
const SNAP_GB = (process.env.LEAK_TRACE_SNAP_GB || "3,4.5")
  .split(",").map(s => parseFloat(s)).filter(Number.isFinite);
const SNAP_THRESHOLDS = SNAP_GB.map(g => g * 1024 * 1024 * 1024);
const MAX_SNAPS = parseInt(process.env.LEAK_TRACE_MAX_SNAPS || "3", 10);

let _snapsTaken = 0;
const _firedThresholds = new Set();

function _fmtMB(b) { return Math.round(b / 1024 / 1024); }

function _regStats() {
  try {
    const rr = require("./run-registry");
    if (typeof rr._leakStats === "function") return rr._leakStats();
  } catch {}
  return null;
}
function _procCounts() {
  try {
    const ps = require("./proc-state");
    return { activeRuns: ps.activeProcBySession ? ps.activeProcBySession.size : null,
             activeProcs: ps.activeProcs ? ps.activeProcs.size : null };
  } catch { return {}; }
}
function _wssClients() {
  try {
    const b = require("./ws/broadcast");
    const wss = b.getWss && b.getWss();
    return wss && wss.clients ? wss.clients.size : null;
  } catch { return null; }
}

function _maybeSnapshot(rss) {
  if (_snapsTaken >= MAX_SNAPS) return;
  for (let i = 0; i < SNAP_THRESHOLDS.length; i++) {
    const t = SNAP_THRESHOLDS[i];
    if (rss >= t && !_firedThresholds.has(i)) {
      _firedThresholds.add(i);
      // disk guard: snapshot ~= heap size; bail if <10G free
      try {
        const st = fs.statfsSync ? fs.statfsSync(DATA_DIR) : null;
        if (st && (st.bavail * st.bsize) < 10 * 1024 * 1024 * 1024) {
          console.log("[leak-trace] skip snapshot — <10G disk free");
          return;
        }
      } catch {}
      const file = path.join(DATA_DIR, `heap-${SNAP_GB[i]}gb-${Date.now()}.heapsnapshot`);
      console.log(`[leak-trace] RSS ${_fmtMB(rss)}MB crossed ${SNAP_GB[i]}G — writing heap snapshot (event loop will pause a few seconds): ${file}`);
      try {
        v8.writeHeapSnapshot(file);
        _snapsTaken++;
        console.log(`[leak-trace] snapshot written (${_snapsTaken}/${MAX_SNAPS}): ${file}`);
      } catch (e) {
        console.log("[leak-trace] snapshot failed:", e.message);
      }
      return; // one snapshot per sample tick
    }
  }
}

function _sample() {
  const m = process.memoryUsage();
  const reg = _regStats();
  const pc = _procCounts();
  const row = {
    ts: Date.now(),
    rss_mb: _fmtMB(m.rss),
    heapUsed_mb: _fmtMB(m.heapUsed),
    heapTotal_mb: _fmtMB(m.heapTotal),
    external_mb: _fmtMB(m.external),
    arrayBuffers_mb: _fmtMB(m.arrayBuffers),
    activeRuns: pc.activeRuns,
    activeProcs: pc.activeProcs,
    wssClients: _wssClients(),
    regSessions: reg ? reg.sessions : null,
    openTools: reg ? reg.openTools : null,
    maxOpenTools: reg ? reg.maxOpen : null,
    maxOpenSid: reg ? reg.maxSid : null,
  };
  try { fs.appendFileSync(TRACE_PATH, JSON.stringify(row) + "\n"); } catch {}
  // Human line to the journal so `journalctl -u llm-terminal | grep leak-trace` works.
  console.log(`[leak-trace] rss=${row.rss_mb}MB heapUsed=${row.heapUsed_mb} ext=${row.external_mb} arrBuf=${row.arrayBuffers_mb} | runs=${row.activeRuns} procs=${row.activeProcs} ws=${row.wssClients} | reg=${row.regSessions} openTools=${row.openTools}(max ${row.maxOpenTools}@${row.maxOpenSid})`);
  _maybeSnapshot(m.rss);
}

function start() {
  if (process.env.LEAK_TRACE === "0") { console.log("[leak-trace] disabled via LEAK_TRACE=0"); return; }
  console.log(`[leak-trace] enabled — sampling every ${SAMPLE_MS}ms, snapshots at ${SNAP_GB.join("G/")}G RSS -> ${DATA_DIR}`);
  _sample(); // baseline at boot
  const t = setInterval(_sample, SAMPLE_MS);
  if (t.unref) t.unref(); // never keep the process alive for the tracer
}

module.exports = { start };

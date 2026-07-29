// deferred-restart: restart llm-terminal AFTER the current turn, not during it.
//
// Why (2026-07-29). An agent that edits server code and then restarts
// llm-terminal is restarting the process that is its own parent. SIGTERM ->
// gracefulShutdown waits up to 60s for active subprocesses -> the only active
// subprocess IS the agent, which is blocked waiting on the restart it asked
// for. Sixty seconds later systemd SIGKILLs it mid-sentence. Twice in one
// session David got a run killed before its reply reached him; the recovery
// machinery re-fired the turn and the resumed agent answered with nothing,
// so from his side the chat just went blank.
//
// The deadlock is structural, not a timing fluke: the waiter and the waited-on
// are the same process tree. So don't ask an in-turn agent to time it right —
// remove the choice. request() records the intent and returns immediately; the
// restart fires once no run is active. The agent finishes its turn, its reply
// lands, and the restart happens in the gap after.
//
// Fires at most one restart per request, and only for allowlisted units (the
// hero-restart-helper enforces this too, but a bad unit should fail at request
// time where the caller can see it, not silently later).
const net = require("net");

const SOCKET = "/run/hero-restart/restart.sock";
const ALLOWED = new Set([
  "llm-terminal", "hostchat", "hostchat-dev", "oshero-daemon", "cloudflared",
  "hero-dispatch", "queue-supervisor",
  "chromium-camohero", "chromium-crankhero", "chromium-langhero",
  "chromium-llmterminal", "chromium-orchestratorhero",
]);

let pending = null;   // { unit, reason, sessionId, at }
let firing = false;

// Talk to hero-restart-helper. Fire-and-forget by design: restarting our own
// unit means the reply arrives after we are already gone.
function _send(unit, cb) {
  let done = false;
  const finish = (err, resp) => { if (!done) { done = true; cb(err, resp); } };
  const sock = net.createConnection(SOCKET);
  sock.setTimeout(10000);
  sock.on("connect", () => sock.end(JSON.stringify({ action: "restart", unit })));
  let buf = "";
  sock.on("data", (d) => { buf += d.toString(); });
  sock.on("close", () => finish(null, buf));
  sock.on("timeout", () => { sock.destroy(); finish(null, "(no reply — expected when restarting our own unit)"); });
  sock.on("error", (e) => finish(e));
}

// Queue a restart for the next moment no run is active.
// Returns { ok, queued, error } — synchronous, never blocks the caller.
function request({ unit, reason, sessionId }) {
  if (!ALLOWED.has(unit)) return { ok: false, error: `unit not allowlisted: ${unit}` };
  if (pending) {
    // Collapse repeats: one restart settles any number of code edits, and a
    // restart-per-edit loop is the documented way to make things worse.
    if (pending.unit === unit) return { ok: true, queued: true, collapsed: true, pending };
    return { ok: false, error: `a restart of '${pending.unit}' is already queued` };
  }
  pending = { unit, reason: reason || "", sessionId: sessionId || null, at: Date.now() };
  console.log(`[deferred-restart] queued '${unit}' for when runs drain` +
              (reason ? ` — ${reason}` : ""));
  return { ok: true, queued: true, pending };
}

// Called on a timer. `activeCount` is the number of live agent subprocesses;
// while any run is in flight the restart waits, because killing it is the exact
// failure this module exists to prevent.
function tick(activeCount) {
  if (!pending || firing) return;
  if (activeCount > 0) return;
  firing = true;
  const { unit, reason } = pending;
  pending = null;
  console.log(`[deferred-restart] no active runs — restarting '${unit}'` +
              (reason ? ` — ${reason}` : ""));
  _send(unit, (err, resp) => {
    firing = false;
    if (err) console.error(`[deferred-restart] '${unit}' FAILED:`, err.message);
    else console.log(`[deferred-restart] '${unit}' helper said:`, String(resp).trim().slice(0, 200));
  });
}

function status() {
  return { pending, firing };
}

module.exports = { request, tick, status, ALLOWED, SOCKET };

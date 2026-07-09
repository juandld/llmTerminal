// Offline simulation for run-ledger.js (loop-hardening L4): exercises ledger
// writes (spawn/first_output/heartbeat/exit), the spawn-without-exit wedge
// signature, the orphan scan against a FAKE /proc tree, the kill-flag default,
// and the sweeper evidence line. No claude spawns, no server needed.
//   node web/scripts/test-run-ledger.js
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-ledger-test-"));
const LEDGER = path.join(tmp, "run-ledger.jsonl");
process.env.LLMT_RUN_LEDGER_PATH = LEDGER; // must be set before require
delete process.env.LLMT_ORPHAN_KILL_BEFORE_SPAWN; // assert the default is OFF

const ledger = require(path.join(__dirname, "..", "src", "run-ledger.js"));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS", name);
  else { failures++; console.error("  FAIL", name, extra || ""); }
}
function rows() {
  return fs.readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
}

(async () => {
  console.log("== phase 1: full lifecycle — spawn / first_output / heartbeat / exit ==");
  const t1 = ledger.trackRun({
    sessionId: "sess-alpha", pid: 11111, trigger: "user",
    model: "claude-opus-4-7", resumeOf: "cli-abc-123", argv: ["-p", "hi", "--resume", "cli-abc-123"],
    heartbeatMs: 40, // test override; production default is 30s
  });
  t1.output(100);
  t1.output(50);
  await new Promise(r => setTimeout(r, 110)); // let >=2 heartbeats fire
  t1.exit(0, null, "result");
  t1.exit(0, null, "result"); // idempotence: must not double-write

  let r = rows().filter(x => x.session_id === "sess-alpha");
  const spawn1 = r.filter(x => x.event === "spawn");
  check("one spawn entry", spawn1.length === 1);
  check("spawn fields", spawn1[0] && spawn1[0].pid === 11111 && spawn1[0].trigger === "user"
    && spawn1[0].resume_of === "cli-abc-123" && /^[0-9a-f]{12}$/.test(spawn1[0].argv_hash || ""), JSON.stringify(spawn1[0]));
  const fo = r.filter(x => x.event === "first_output");
  check("exactly one first_output with latency_ms", fo.length === 1 && typeof fo[0].latency_ms === "number");
  const hb = r.filter(x => x.event === "heartbeat");
  check(">=2 heartbeats while running", hb.length >= 2, "got " + hb.length);
  check("heartbeat carries bytes_out + last_event_age_s",
    hb.every(x => typeof x.bytes_out === "number" && typeof x.last_event_age_s === "number"));
  const ex = r.filter(x => x.event === "exit");
  check("exactly one exit (idempotent)", ex.length === 1);
  check("exit fields", ex[0] && ex[0].code === 0 && ex[0].bytes_out === 150
    && typeof ex[0].duration_ms === "number" && ex[0].terminal_reason === "result", JSON.stringify(ex[0]));
  await new Promise(r2 => setTimeout(r2, 90));
  check("no heartbeats after exit", rows().filter(x => x.session_id === "sess-alpha" && x.event === "heartbeat").length === hb.length);

  console.log("== phase 2: the wedge signature — spawn WITHOUT exit is detectable by construction ==");
  const t2 = ledger.trackRun({ sessionId: "sess-wedged", pid: 22222, trigger: "recovery",
    model: "claude-opus-4-7", resumeOf: "cli-def-456", argv: ["--resume", "cli-def-456"], heartbeatMs: 60000 });
  void t2; // simulated SIGKILL: exit() never called — exactly the 16:59 shape
  const w = rows().filter(x => x.session_id === "sess-wedged");
  check("wedge session has spawn, trigger=recovery", w.some(x => x.event === "spawn" && x.trigger === "recovery"));
  check("wedge session has NO exit", !w.some(x => x.event === "exit"));
  // The detection query an operator (or a future scan) runs against the file:
  const openRuns = (() => {
    const spawns = new Map(), exits = new Set();
    for (const x of rows()) {
      if (x.event === "spawn") spawns.set(x.session_id + ":" + x.pid, x);
      if (x.event === "exit") exits.add(x.session_id + ":" + x.pid);
    }
    return [...spawns.keys()].filter(k => !exits.has(k));
  })();
  check("spawn-without-exit query finds exactly the wedged run",
    openRuns.length === 1 && openRuns[0] === "sess-wedged:22222", JSON.stringify(openRuns));

  console.log("== phase 3: orphan scan against fake /proc ==");
  const fakeProc = path.join(tmp, "proc");
  const mk = (pid, argv) => {
    fs.mkdirSync(path.join(fakeProc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(fakeProc, String(pid), "cmdline"), argv.join("\0") + "\0");
  };
  const CSID = "9f3e2a10-dead-beef-cafe-0123456789ab";
  mk(4242, ["claude", "-p", "loop it", "--resume", CSID]);          // the orphan
  mk(4243, ["claude", "-p", "other", "--resume", "some-other-sid"]); // different session
  mk(4244, ["python3", "queue_supervisor.py", CSID]);                // mentions sid, not claude
  fs.mkdirSync(path.join(fakeProc, "self"), { recursive: true });    // non-numeric entry
  const hits = ledger.scanOrphans(CSID, { procRoot: fakeProc, selfPid: 99999 });
  check("scan finds exactly the claude --resume orphan", hits.length === 1 && hits[0].pid === 4242, JSON.stringify(hits));
  check("orphan has age_s", typeof hits[0].age_s === "number");
  check("scan of a session with no orphans is empty", ledger.scanOrphans("nope-nope", { procRoot: fakeProc }).length === 0);
  check("self pid is excluded", ledger.scanOrphans(CSID, { procRoot: fakeProc, selfPid: 4242 }).length === 0);

  console.log("== phase 4: checkOrphansBeforeSpawn — logs loudly, kill default OFF ==");
  const found = ledger.checkOrphansBeforeSpawn("sess-alpha", CSID, { procRoot: fakeProc, selfPid: 99999 });
  check("returns the orphan", found.length === 1 && found[0].pid === 4242);
  const od = rows().filter(x => x.event === "orphan_detected");
  check("orphan_detected ledger entry written", od.length === 1
    && od[0].orphan_pid === 4242 && od[0].session_id === "sess-alpha" && od[0].resume_of === CSID, JSON.stringify(od));
  check("default action is log-and-proceed (kill flag OFF)", od[0].action === "log-and-proceed", od[0] && od[0].action);
  // kill flag ON against a certainly-dead pid: action recorded, no throw
  ledger.checkOrphansBeforeSpawn("sess-alpha", CSID, { procRoot: fakeProc, selfPid: 99999, kill: true });
  const od2 = rows().filter(x => x.event === "orphan_detected");
  check("kill=true records a sigterm action without throwing", od2.length === 2
    && /^sigterm/.test(od2[1].action), od2[1] && od2[1].action);

  console.log("== phase 5: sweeper evidence line ==");
  check("evidence for tracked session names last event",
    /^ledger: (exit|orphan_detected) \d+s ago/.test(ledger.evidence("sess-alpha")), ledger.evidence("sess-alpha"));
  check("evidence includes pid liveness", /pid \d+ (ALIVE|gone)/.test(ledger.evidence("sess-wedged")), ledger.evidence("sess-wedged"));
  check("evidence for unknown session is explicit", ledger.evidence("never-seen") === "ledger: no entry this boot");

  console.log(failures === 0 ? "\nALL PASS (" + rows().length + " ledger rows written to " + LEDGER + ")" : "\n" + failures + " FAILURE(S)");
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
})();

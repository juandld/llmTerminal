#!/usr/bin/env node
// jobctl — let ANY script beat into the jobs ledger.
//   jobctl start <id> --label L --kind K [--total N] [--parent P] [--log F] [--interval ms]
//   jobctl beat <id> [--progress P] [--done N] [--note ...]
//   jobctl done|failed|killed <id> [--note ...] [--result F]
const jobs = require("/home/claude-user/projects/llmTerminal/web/src/jobs.js");
const [cmd, id, ...rest] = process.argv.slice(2);
const o = {}; for (let i = 0; i < rest.length; i += 2) if (rest[i]?.startsWith("--")) o[rest[i].slice(2)] = rest[i + 1];
if (!cmd || !id) { console.error("usage: jobctl start|beat|done|failed|killed <id> [--opts]"); process.exit(1); }
if (cmd === "start") jobs.startJob({ id, label: o.label, kind: o.kind || "task", parent: o.parent || null, total: o.total ? +o.total : null, log_path: o.log || null, beat_interval_ms: o.interval ? +o.interval : 60000, reversible: o.reversible !== "false" });
else if (cmd === "beat") jobs.beatJob(id, { progress: o.progress ?? null, done: o.done != null ? +o.done : null, note: o.note ?? null });
else if (["done", "failed", "killed", "stalled"].includes(cmd)) jobs.endJob(id, cmd === "done" ? "done" : cmd, { note: o.note ?? null, result_path: o.result ?? null });
else { console.error("unknown cmd: " + cmd); process.exit(1); }

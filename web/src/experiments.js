// A/B experiments data pipe (HARNESS_PLAN #3) — MVP scaffolding.
//
// This module ships the DATA PIPE for measuring per-turn variant deltas.
// It is NOT a decision framework: a single operator (David) generating
// session-level A/B assignments will not produce statistically meaningful
// signal in a reasonable timeframe. The `summarize()` output enforces this
// by prepending an N=1 caveat whenever any variant arm has fewer than
// N_THRESHOLD sessions.
//
// The real scientific machinery lands in HARNESS_PLAN slot #6 (fork-and-
// select): each fork-and-select round writes {type:"fork_result",
// winnerVariant, loserVariants, judgeReasoning, ...} rows to the SAME
// experiments.jsonl file, and the summary route surfaces both session-
// level and turn-level comparisons from one file. Every turn is an
// experiment; every session is just a rollup view. This file exports the
// primitives (assignVariants, recordTurn, recordSessionEnd, summarize)
// that slot #6 will consume.

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const EXPERIMENTS_LOG = path.join(DATA_DIR, "experiments.jsonl");

// Slot #6: lifted from a single hardcoded experiment to a small registry,
// as this file's own original comment promised. Still inline (not a config
// file) — the registry is small enough that a JSON file would be
// premature; revisit if it grows past a handful of entries.
const ORCHESTRATE_EXPERIMENT = { name: "orchestrate", variants: ["on", "off"] };
// The tournament arm (slot #6): full-decompose vs minimal-direct-execution,
// see plugins/orchestrate-tournament/skills/{orchestrate-full,orchestrate-minimal}.
// Meaningful mainly when orchestrate:on (no skill choice matters if
// orchestrate is off entirely) — assigned independently anyway so the data
// pipe stays clean and uniform; a minimal-arm session with orchestrate:off
// is simply a no-op combination, not an error.
const ORCHESTRATE_STYLE_EXPERIMENT = { name: "orchestrate_style", variants: ["full", "minimal"] };
const EXPERIMENTS = [ORCHESTRATE_EXPERIMENT, ORCHESTRATE_STYLE_EXPERIMENT];

// In-memory guard: don't record the same (session, lastUserTs) turn twice
// when the contract-check re-fires within the same turn window.
const _lastTurnRecordedTs = Object.create(null);
// In-memory session_end guard. Session_end rows are also gated by
// session._experimentSessionEndRecorded (persisted on the session record
// at the manualDone-set path); this Set catches the stalled-sweep path
// where we don't necessarily write the session record ourselves.
const _sessionEndRecorded = new Set();

function assignVariants(session) {
  if (!session) return null;
  session.variants = session.variants || {};
  for (const exp of EXPERIMENTS) {
    // Idempotent per-experiment: if this experiment's arm is already
    // stamped (e.g. a chat reopened after reload), don't re-flip it — but
    // DO still assign any OTHER experiment in the registry that isn't
    // stamped yet, so adding a new experiment later doesn't require
    // touching every already-persisted session.
    if (session.variants[exp.name]) continue;
    const idx = Math.floor(Math.random() * exp.variants.length);
    session.variants[exp.name] = exp.variants[idx];
  }
  return session.variants;
}

function _appendRow(row) {
  try {
    fs.appendFileSync(EXPERIMENTS_LOG, JSON.stringify(row) + "\n");
  } catch (e) {
    console.error("[experiments] append failed:", e.message);
  }
}

// Called from spawnContractCheck. `opts.lastUserTs` is the ts of the user
// message that started the turn — used as the dedup key.
function recordTurn(session, opts) {
  if (!session || !session.id) return;
  if (!session.variants) return; // pre-experiment sessions — don't taint the log
  const o = opts || {};
  const lastUserTs = o.lastUserTs || 0;
  if (!lastUserTs) return; // no anchor for this turn; skip
  if (_lastTurnRecordedTs[session.id] === lastUserTs) return; // already recorded
  _lastTurnRecordedTs[session.id] = lastUserTs;
  const row = {
    type: "turn",
    ts: Date.now(),
    sessionId: session.id,
    project: session.project || null,
    variants: session.variants,
    turnIndex: o.turnIndex || 0,
    latencyMs: Math.max(0, o.latencyMs || 0),
    toolCount: o.toolCount || 0,
    endedSession: !!o.endedSession,
  };
  _appendRow(row);
}

function recordSessionEnd(session, opts) {
  if (!session || !session.id) return;
  if (!session.variants) return;
  if (_sessionEndRecorded.has(session.id)) return;
  if (session._experimentSessionEndRecorded) {
    _sessionEndRecorded.add(session.id);
    return;
  }
  _sessionEndRecorded.add(session.id);
  const o = opts || {};
  const row = {
    type: "session_end",
    ts: Date.now(),
    sessionId: session.id,
    project: session.project || null,
    variants: session.variants,
    totalTurns: o.totalTurns || 0,
    totalUserMsgs: o.totalUserMsgs || 0,
    endedVia: o.endedVia || "complete", // 'complete' | 'stalled'
    totalDurationMs: Math.max(0, o.totalDurationMs || 0),
  };
  _appendRow(row);
  // Slot #4: fire-and-forget frustration classifier. Runs Haiku on the
  // recent transcript, appends a separate 'session_score' row keyed by
  // sessionId. summarize() joins on sessionId. Failure is silent — the
  // session_end row above is the authoritative record either way.
  try { scoreSessionFrustration(session); }
  catch (e) { console.warn("[experiments] frustration score kick failed:", e.message); }
}

// Slot #4 (frustration classifier). Reads the last ~20 user+assistant
// messages for this session, asks Haiku to classify the *user's* overall
// signal as one of {frustrated, neutral, positive} + a boolean 'stuck'
// (user had to repeat themselves / escalate). Writes a 'session_score'
// row so summarize() can aggregate frustration rate per variant.
//
// Design note: we score the USER's signal, not the agent's — the variant
// is the manipulated variable, David's frustration is the outcome.
// Non-blocking (fire-and-forget): the session_end row is the authoritative
// record; the score row is a joinable annotation that arrives when Haiku
// finishes (~5-10s later).
function scoreSessionFrustration(session) {
  if (!session || !session.id || !session.variants) return;
  // Lazy require to keep this file loadable even if cheap-model is broken
  // (belt-and-suspenders — cheap-model.js is stable, but the classifier
  // is a slot #4 upgrade and shouldn't take down the whole data pipe).
  let loadMessages, runCheapClaude;
  try {
    loadMessages = require("./store").loadMessages;
    runCheapClaude = require("./cheap-model").runCheapClaude;
  } catch (e) {
    console.warn("[experiments] frustration classifier deps unavailable:", e.message);
    return;
  }
  let messages;
  try { messages = loadMessages(session.id) || []; }
  catch { return; }
  // Skip trivial sessions — under 4 user+assistant messages is not enough
  // to judge frustration.
  const relevant = messages.filter(m => m.role === "user" || m.role === "assistant");
  if (relevant.length < 4) return;
  const recent = relevant.slice(-20);
  const transcript = recent.map(m => {
    const role = m.role === "user" ? "USER" : "AGENT";
    const text = String(m.text || m.summary || "").slice(0, 500);
    return role + ": " + text;
  }).filter(Boolean).join("\n\n");
  if (transcript.length < 100) return;
  const prompt = `You are auditing an operator-agent chat to classify the OPERATOR's frustration level with the AGENT's performance. Judge only the USER's signal — not the agent's quality.

Rubric:
- frustrated: user used bad words at agent, expressed "why did you", "no stop", "I already said", "listen", "wtf", ALL CAPS runs, or had to repeat the same ask 2+ times.
- neutral: user gave direction, agent executed, no visible corrective escalation.
- positive: user expressed satisfaction ("perfect", "exactly", "great", "nice"), accepted a non-obvious choice without pushback, or explicitly praised.
- stuck: separate boolean — did the user have to repeat themselves or bail on a thread? (independent of frustration; e.g. "actually let's try something else" = stuck=true)

If (and only if) level is "frustrated" OR stuck is true, additionally classify:

root_cause — pick exactly ONE bucket for WHY the friction happened:
  - "stale-context"     : agent trusted stale info in prompt/memory instead of live data
  - "missed-check"      : agent acted without verifying an assumption it could have checked
  - "bad-tool-call"     : wrong tool params, hallucinated attribute, tool used incorrectly
  - "over-eager-action" : agent did more than the user asked / took unauthorized action
  - "misread-intent"    : agent misinterpreted what the user wanted
  - "tool-limitation"   : the tool genuinely doesn't do what was needed (not agent's fault)
  - "unknown"           : cannot classify from transcript alone

intervention_hint — pick ONE plausible fix:
  - "hook"              : harness hook (SessionStart, PreToolUse, PostToolUse) would have caught it
  - "memory"            : a feedback memory would keep future sessions from repeating
  - "tool-wrapper"      : a defensive wrapper around a tool would enforce the check
  - "prompt-injection"  : adding a specific line to the system prompt would remind the agent
  - "none"              : no clean fix; a judgment call the agent has to make case-by-case

If level is "neutral" or "positive" and stuck is false, set both fields to null.

Output JSON only (no prose, no fences):
{"level": "frustrated"|"neutral"|"positive", "stuck": true|false, "signals": "one short sentence quoting the strongest evidence", "root_cause": <bucket or null>, "intervention_hint": <bucket or null>}

Transcript:
${transcript}`;
  try {
    runCheapClaude(prompt, "frustration-scorer", (parsed) => {
      if (!parsed || !parsed.level) return;
      // Root-cause and intervention-hint are only meaningful for
      // frustrated-or-stuck sessions; neutral/positive rows carry null so
      // aggregation counts don't drift with irrelevant data.
      const ROOT_CAUSE_VALID = new Set([
        "stale-context", "missed-check", "bad-tool-call",
        "over-eager-action", "misread-intent", "tool-limitation", "unknown",
      ]);
      const INTERVENTION_VALID = new Set([
        "hook", "memory", "tool-wrapper", "prompt-injection", "none",
      ]);
      const shouldClassify = parsed.level === "frustrated" || !!parsed.stuck;
      const rootCause = shouldClassify && ROOT_CAUSE_VALID.has(parsed.root_cause)
        ? parsed.root_cause : null;
      const interventionHint = shouldClassify && INTERVENTION_VALID.has(parsed.intervention_hint)
        ? parsed.intervention_hint : null;
      _appendRow({
        type: "session_score",
        ts: Date.now(),
        sessionId: session.id,
        project: session.project || null,
        variants: session.variants,
        frustration: parsed.level,
        stuck: !!parsed.stuck,
        signals: String(parsed.signals || "").slice(0, 200),
        root_cause: rootCause,
        intervention_hint: interventionHint,
      });
    }, session.project);
  } catch (e) {
    console.warn("[experiments] runCheapClaude threw synchronously:", e.message);
  }
}

function _median(arr) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// Threshold at which we stop prepending the N=1 caveat. Chosen for MVP as
// "the smallest sample size a single-operator A/B could plausibly generate
// per arm within a week or two of daily use" — still well below what the
// social-sciences call statistically meaningful, but a signal that the
// data-pipe is producing rows.
const N_THRESHOLD = 20;

function summarize() {
  const rows = [];
  try {
    const raw = fs.readFileSync(EXPERIMENTS_LOG, "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") {
      return "[experiments] read failed: " + e.message + "\n";
    }
    // ENOENT = log doesn't exist yet, treat as empty.
  }

  // Group by experiment name → variant → aggregates
  const groups = {};
  for (const r of rows) {
    if (!r || !r.variants) continue;
    for (const [expName, variant] of Object.entries(r.variants)) {
      groups[expName] = groups[expName] || {};
      groups[expName][variant] = groups[expName][variant] || {
        turnLatencies: [],
        turnsBySession: {},
        sessionsCompleted: new Set(),
        sessionsStalled: new Set(),
        sessionsSeen: new Set(),
      };
      const g = groups[expName][variant];
      g.sessionsSeen.add(r.sessionId);
      // Slot #4 aggregates — initialized on first sighting so the shape is
      // stable even for variants with no scores yet.
      g.frustration = g.frustration || { frustrated: 0, neutral: 0, positive: 0, stuck: 0, scored: 0 };
      // Slot #4 root-cause / intervention-hint buckets — populated only for
      // frustrated-or-stuck rows (classifier writes null otherwise).
      g.rootCauses = g.rootCauses || Object.create(null);
      g.interventions = g.interventions || Object.create(null);
      if (r.type === "turn") {
        g.turnLatencies.push(r.latencyMs || 0);
        g.turnsBySession[r.sessionId] = (g.turnsBySession[r.sessionId] || 0) + 1;
      } else if (r.type === "session_end") {
        if (r.endedVia === "complete") g.sessionsCompleted.add(r.sessionId);
        else if (r.endedVia === "stalled") g.sessionsStalled.add(r.sessionId);
      } else if (r.type === "session_score") {
        // Slot #4: one score row per session (idempotent-per-fire via
        // _sessionEndRecorded); count each level.
        g.frustration.scored += 1;
        if (r.frustration === "frustrated") g.frustration.frustrated += 1;
        else if (r.frustration === "positive") g.frustration.positive += 1;
        else g.frustration.neutral += 1;
        if (r.stuck) g.frustration.stuck += 1;
        if (r.root_cause) g.rootCauses[r.root_cause] = (g.rootCauses[r.root_cause] || 0) + 1;
        if (r.intervention_hint) g.interventions[r.intervention_hint] = (g.interventions[r.intervention_hint] || 0) + 1;
      }
    }
  }

  const lines = [];
  // N=1 caveat — always prepend when ANY variant arm has n<N_THRESHOLD
  // sessions. Non-negotiable header so David can never be fooled by noise.
  let anyLowN = false;
  let anyHighN = Object.keys(groups).length === 0 ? false : true;
  for (const byVariant of Object.values(groups)) {
    for (const g of Object.values(byVariant)) {
      const n = g.sessionsSeen.size;
      if (n < N_THRESHOLD) anyLowN = true;
      if (n < N_THRESHOLD) anyHighN = false;
    }
  }
  if (anyLowN || !Object.keys(groups).length) {
    const lowestN = Object.keys(groups).length
      ? Math.min(...Object.values(groups).flatMap(bv => Object.values(bv).map(g => g.sessionsSeen.size)))
      : 0;
    lines.push("=== N=" + lowestN + " CAVEAT ===");
    lines.push("At least one variant arm has fewer than " + N_THRESHOLD + " sessions.");
    lines.push("Treat this as DATA-PIPE VERIFICATION ONLY, not a decision");
    lines.push("framework. Session-level A/B with a single operator will not");
    lines.push("produce statistically meaningful signal for months. HARNESS_PLAN");
    lines.push("slot #6 (fork-and-select) is where the real scientific machinery");
    lines.push("lives — it writes per-turn winner/loser rows to this same file.");
    lines.push("");
  }

  lines.push("experiments summary (" + rows.length + " total rows, " +
    Object.keys(groups).length + " experiment(s))");
  lines.push("");

  if (!Object.keys(groups).length) {
    lines.push("(no rows yet — start a new chat to assign a variant, then");
    lines.push("send prompts to record per-turn data.)");
    return lines.join("\n") + "\n";
  }

  for (const [expName, byVariant] of Object.entries(groups)) {
    lines.push("== " + expName + " ==");
    lines.push("variant | n sess | median ms | med turns | complete | frustrated | positive | stuck");
    lines.push("--------+--------+-----------+-----------+----------+------------+----------+------");
    for (const [variant, g] of Object.entries(byVariant)) {
      const n = g.sessionsSeen.size;
      const medLat = _median(g.turnLatencies);
      const turnCounts = Object.values(g.turnsBySession);
      const medTurns = _median(turnCounts);
      const totalEnded = g.sessionsCompleted.size + g.sessionsStalled.size;
      const completeRate = totalEnded
        ? (g.sessionsCompleted.size / totalEnded).toFixed(2)
        : "n/a";
      // Slot #4 rates: as fractions of SCORED sessions (not sessionsSeen —
      // some may not have session_score rows yet if the classifier failed
      // or is still running).
      const f = g.frustration || { frustrated: 0, positive: 0, stuck: 0, scored: 0 };
      const fRate = f.scored ? (f.frustrated / f.scored).toFixed(2) : "n/a";
      const pRate = f.scored ? (f.positive / f.scored).toFixed(2) : "n/a";
      const sRate = f.scored ? (f.stuck / f.scored).toFixed(2) : "n/a";
      lines.push([
        variant.padEnd(7),
        String(n).padStart(6),
        medLat === null ? "   n/a" : String(Math.round(medLat)).padStart(9),
        medTurns === null ? "   n/a" : String(medTurns).padStart(9),
        String(completeRate).padStart(8),
        String(fRate).padStart(10),
        String(pRate).padStart(8),
        String(sRate).padStart(5),
      ].join(" | "));
    }
    lines.push("");
  }

  // Slot #4 upgrade: cross-variant "why does friction happen" rollup, so
  // David can see the top harness-debt buckets in one glance without having
  // to eyeball per-variant tables.
  //
  // Aggregate directly from the raw rows (deduped by sessionId), NOT by
  // summing the per-variant `g.rootCauses` counts — a session with N
  // experiments has its score walked N times in `groups`, so summing the
  // per-variant tallies would multiply counts by N. Semantically the global
  // "how many frustrated sessions had cause X" is per-session, not
  // per-(session × experiment).
  const globalRootCauses = Object.create(null);
  const globalInterventions = Object.create(null);
  const _seenSessions = new Set();
  for (const r of rows) {
    if (!r || r.type !== "session_score" || !r.sessionId) continue;
    if (_seenSessions.has(r.sessionId)) continue;
    _seenSessions.add(r.sessionId);
    if (r.root_cause) globalRootCauses[r.root_cause] = (globalRootCauses[r.root_cause] || 0) + 1;
    if (r.intervention_hint) globalInterventions[r.intervention_hint] = (globalInterventions[r.intervention_hint] || 0) + 1;
  }
  const rcEntries = Object.entries(globalRootCauses).sort((a, b) => b[1] - a[1]);
  const ivEntries = Object.entries(globalInterventions).sort((a, b) => b[1] - a[1]);
  if (rcEntries.length || ivEntries.length) {
    lines.push("== friction root-causes (across all variants) ==");
    if (rcEntries.length) {
      const total = rcEntries.reduce((s, [, v]) => s + v, 0);
      for (const [k, v] of rcEntries) {
        const pct = total ? Math.round((v / total) * 100) : 0;
        lines.push("  " + k.padEnd(20) + " " + String(v).padStart(4) + "  (" + pct + "%)");
      }
    } else {
      lines.push("  (no frustrated/stuck sessions scored yet)");
    }
    lines.push("");
    lines.push("== proposed interventions (across all variants) ==");
    if (ivEntries.length) {
      const total = ivEntries.reduce((s, [, v]) => s + v, 0);
      for (const [k, v] of ivEntries) {
        const pct = total ? Math.round((v / total) * 100) : 0;
        lines.push("  " + k.padEnd(20) + " " + String(v).padStart(4) + "  (" + pct + "%)");
      }
    } else {
      lines.push("  (no intervention hints yet)");
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

module.exports = {
  ORCHESTRATE_EXPERIMENT,
  ORCHESTRATE_STYLE_EXPERIMENT,
  assignVariants,
  recordTurn,
  recordSessionEnd,
  summarize,
  // Exposed for slot #6 (fork-and-select) to write fork_result rows to the
  // same log without duplicating the append+error-swallow code.
  _appendRow,
};

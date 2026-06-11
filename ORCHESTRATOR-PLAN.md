# Orchestrator Plan — the shadow that keeps heroes alive

> Companion to `ARCHITECTURE.md` §4. This is the build plan for the **missing
> keystone**: the real orchestrator. Read §4 first. Status: PLAN (nothing here is
> built yet except the signals it will consume, which already exist).

---

## What it's for (the one sentence)

**Keep every hero's momentum alive across the operator's attention shifts** — so
an idea doesn't die just because David looked away. Today David *is* the
orchestrator; a hero goes dormant the moment his attention moves. The orchestrator
is the half of "weaponize ADHD" that defends the kryptonite (follow-through): it
carries momentum the operator's attention can't.

Three things it must deliver, in David's words:
1. **Keeps attention going** — heroes don't die from inattention.
2. **I can actually see results** — a morning surface of what moved, not a black box.
3. **Works while I sleep** — overnight progress on safe (reversible) work.

And one hard constraint: **no Telegram spam.** If David can see an alert, the
system could too — so the orchestrator *resolves* what it can and escalates only
the genuinely unresolvable (mirrors `osHero/alerter.py`, which already suppresses
routine downs).

---

## The model (from §4, made concrete)

You don't *design* the orchestrator top-down — you **grow it by watching David
orchestrate**, because he already produces the training data daily. Orchestrating
is five repeated moves:

| Move | What David does now | Signal already captured |
|------|--------------------|--------------------------|
| **Route** | picks which hero/chat to attend next | attention counter, priority scoring, `viewed` |
| **Judge** | "is this run done / half-baked?" | contract-check supervisor, `manualDone` |
| **Redirect** | "no, do it this way" | follow-up user messages |
| **Decompose** | splits an idea across heroes | (not yet captured — Phase 0) |
| **Accept/merge** | "that's the answer," combines | `email-sent`, archive, `llmt_complete` |

The shadow watches these, **predicts** them, and **earns delegation per-move by
measured accuracy** — route first (easiest), judge later, never all at once.

**Why it can be bold:** orchestration is itself *reversible* (routing, judging,
planning, merging touch nothing in the real world). The only irreversible actions
(send / pay / publish) are already gated by the reversibility rule one layer down.
So the shadow can run aggressively — worst case is a reversible mistake.

---

## Architecture

- **Home:** orchestratorHero (the manager; the cockpit is llmTerminal, separate).
- **Reads (signals it consumes — all exist today):** the decisions DB, the
  attention/priority scores, session `lastActive`/`manualDone`/`awaitingResponse`,
  the supervisors' verdicts (observer/decision/contract).
- **Acts (how it does work):** spawns runs through the **same run-path we just
  modularized** — `providers/claude` + `ws/connection`'s prompt flow — but
  headless, each worker in its **own git worktree** (isolation by construction; no
  collision like 2026-06-10).
- **Reports:** writes to a **results store** the cockpit renders as a morning
  digest. Proactive push (Telegram) is reserved for `manual_intervention` only.
- **Shape:** one manager, a flat fan of workers. Wide, never deep (§4).

---

## Continuity substrate: the jobs ledger  *(first brick — BUILT 2026-06-12)*

The orchestrator cannot manage workers it cannot see. The foundation — built first,
serving the operator immediately — is a **jobs ledger**: ONE substrate, two
consumers (the operator's glass-box Jobs view AND the orchestrator's worker tracking).

- **Where:** `~/.llm-terminal/jobs/<id>.json` (one file/job) + `events.jsonl`
  (append-only state changes). Module `web/src/jobs.js`; universal CLI
  `web/scripts/jobctl.js` — any bash/python/node task beats in (`jobctl beat <id> --done N`).
- **Orchestrator-grade schema** (not display-only): `parent` (the §4 fan-of-workers
  under a goal), `result_path` (merge), `last_beat`+`beat_interval_ms` (PROVABLE
  liveness), `reversible` (the §7 gate → irreversible work becomes a pending decision).
- **Anti-silent-hang:** a worker that stops beating flips to `stalled` (proven, not
  guessed) and emits an event — instead of a manager hanging forever (the exact bug
  that froze a chat 2026-06-12). The orchestrator subscribes to job events, not the
  fragile "fire a task that re-invokes me" pattern that died mid-run at segment 225.
- **Status:** ledger + `jobctl` + `/api/jobs` + the cockpit Jobs view (⚙ topbar,
  live, color-coded liveness) are BUILT + deployed.

Later phases ride on it: **Phase 2 (continuity engine)** = spawn each hero-advance as
a ledger job + react to its events; **dormancy + morning results view** = queries
over the ledger; **supervisors (§4)** = an agent-run IS a job, the observer/contract-
check write its row → "supervisor → orchestrator" becomes "writes the row → reads it."

## Phased build (each phase ships value alone; later phases are opt-in)

### Phase 0 — Instrument the five moves *(1 sitting; read-only)*
Log every orchestration move David makes into an `orchestrator_events` table:
route (chat opened), judge (done/reopen), redirect, decompose, accept. Four of
five already have signals; only **decompose** needs a new hook (when David sends
related prompts to multiple heroes for one goal). This is the training data.

### Phase 1 — The Suggester *(zero risk; immediately useful)*
A read-only shadow that watches the signals and **surfaces suggestions** in the
cockpit — never acts:
- "crankHero has been cold 6 days but had momentum — resume?"
- "this run looks done — accept it?"
- "narrativeHero is blocked on a decision you haven't made."
Track **acceptance rate per move-type**. This alone tells David which heroes are
dying and is the accuracy meter that gates Phase 3.

### Phase 2 — The Continuity Engine *("works while I sleep")*
The core. A loop (cron or daemon) that, per hero:
1. Computes **dormancy** (had momentum, now cold N days) and a **next obvious
   step** (from the last decision / open thread / a "what's next" cheap-model call).
2. If the next step is **reversible** (research, draft, scaffold, plan, code on a
   branch) → **does it** headless in an isolated worktree, supervised.
3. If it hits anything **irreversible** (send/pay/publish) → stops and files a
   **pending decision** for the morning digest. Never sends. Never spams.
Result: heroes inch forward overnight instead of dying. David wakes to progress.

### Phase 3 — Delegation Ramp *("little by little")*
For each move-type independently, once Phase-1 suggestion accuracy crosses a
threshold (e.g. 85% over 20 calls), **promote** it suggest → auto. Route graduates
first; judge later; decompose last. Each promotion is reversible (demote if
accuracy drops). David stays in control of the *pace* of delegation.

### Phase 4 — The Morning Results View *("I can actually see results")*
A cockpit surface (new tab or a dashboard card) showing, per hero, what the
orchestrator did overnight:
- progressed (with links to the artifacts/branches)
- waiting on you (the pending decisions from Phase 2)
- couldn't resolve (the only thing also allowed to push to Telegram)
One screen, scannable on a phone, first thing in the morning.

---

## Guardrails (non-negotiable)

- **Reversibility gate is the safety.** Autonomous work is reversible-only;
  irreversible → a queued decision, never an action. (`ARCHITECTURE.md` §7.)
- **Worktree-per-worker** — no two workers share a tree.
- **Alert triage** — self-resolve; escalate only `manual_intervention`. No routine
  pings. (Same contract as `osHero/alerter.py`.)
- **Stays personal/private** — never publishes or exposes the ecosystem.
- **Shallow** — one orchestrator, flat workers; no agent→agent→agent nesting.

---

## The metric

Primary: **"did any hero die from inattention?"** → drive to zero.
Secondary: suggestion-accuracy per move (the gate for delegation).

## Smallest first step

Build **Phase 0 + the dormancy half of Phase 1**: instrument the moves, and ship a
read-only "heroes going cold" list in the cockpit. Zero risk, and it immediately
answers the question that started this — *which of my ideas am I letting die?*

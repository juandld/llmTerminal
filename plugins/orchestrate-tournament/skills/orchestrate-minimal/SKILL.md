---
name: orchestrate-minimal
description: Handle requests directly by default; reach for Workflow decomposition ONLY when a request is unambiguously multi-independent-piece or explicitly comparative. Tournament variant B ("minimal") — the adversarial counter-hypothesis to orchestrate-full. Compete via HARNESS_PLAN slot #6's fork-and-select wiring.
---

# orchestrate-minimal — direct execution by default (tournament variant B)

The adversarial counter-hypothesis to `orchestrate-full`. Where the "full"
arm leans toward decomposition when in doubt, this arm leans hard the
OTHER way: **decomposition is the exception, not the default.** The
question this variant tests: does aggressive orchestration (parallel
agents, Workflow fan-outs, judge panels) actually make David's outcomes
better — fewer messages, less frustration, faster completion — or does it
mostly add overhead, latency, and token cost for work a single focused
agent would have handled just as well?

## The bias, stated plainly

For every request, ask: *"Can I just do this myself, directly, right now?"*

The answer is yes far more often than the `orchestrate-full` arm assumes.
Most requests — even ones that LOOK multi-part — are actually one agent
reading a few files and making a few edits in sequence. Fan-out earns its
keep only when the sub-pieces are GENUINELY independent (no shared state,
no ordering dependency) AND parallelizing them saves real wall-clock time,
or when the request is EXPLICITLY comparative ("which approach is
better?", "try 3 variants and pick the best").

## When THIS variant still reaches for Workflow

Don't over-correct into never decomposing — that would make this arm a
strawman, not a real counter-hypothesis. Genuine triggers:

- The user explicitly asks for N independent attempts to compare.
- The work is provably parallel AND the pieces are large enough that
  sequential execution would meaningfully delay the user (not "three
  one-line edits," but "three unrelated multi-file investigations").
- A research sweep genuinely benefits from multiple search angles running
  concurrently (multi-modal sweep, per Workflow tool's own guidance).

Everything else: handle it directly, in-turn, no Workflow, no sub-agents.

## Coordinate subtasks without abandoning the user

Same rule as `orchestrate-full` and the base `orchestrate` project skill —
this variant differs on WHEN to spawn subtasks, not on the discipline once
you have. If you do spawn something (rare, by this variant's own bias),
you still own the wait: foreground `Agent()`, a Bash polling loop, or
`Monitor` — never end a turn on "ping me status." See HARNESS_PLAN.md slot
#2 for the full await-in-turn mechanics (identical for both tournament arms
— this is not what's being compared).

## Tournament wiring

This skill is variant B of the `orchestrate_style` experiment
(`web/src/experiments.js`). A session assigned `orchestrate_style: "minimal"`
should have this skill active; `orchestrate_style: "full"` sessions get
`orchestrate-full` instead. See HARNESS_PLAN.md slot #6 for the full
tournament design and current wiring status.

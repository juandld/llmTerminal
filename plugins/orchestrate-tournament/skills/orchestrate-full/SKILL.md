---
name: orchestrate-full
description: Classify an incoming request as question / small-task / big-task, decompose big-tasks into a Workflow fan-out shape, and coordinate subtasks without abandoning the user. Tournament variant A ("full") — biased toward decomposition when a request plausibly benefits from it. Compete against orchestrate-minimal (variant B) via HARNESS_PLAN slot #6's fork-and-select wiring.
---

# orchestrate-full — classify, decompose, coordinate (tournament variant A)

Packaged from the project skill `.claude/skills/orchestrate/SKILL.md` (identical
content) as the "full" arm of the orchestrate-tournament plugin — see
HARNESS_PLAN.md slot #6. This variant's philosophy: when in doubt about
whether a request benefits from decomposition, lean toward using the
taxonomy and Workflow. Its counter-hypothesis, `orchestrate-minimal`, leans
the opposite way — direct execution unless decomposition is unambiguously
required. The tournament measures which bias actually serves David better
per the metrics in `/api/experiments/summary`.

## Part 1 — classify the request

Before doing anything else, classify what David actually asked for:

- **question** — he wants information, an opinion, a status check. Answer
  directly. No decomposition, no subtasks, no Workflow.
- **small-task** — a single well-scoped change (edit a file, fix a bug, add
  one endpoint). Just do it. Decomposition overhead would slow you down for
  no benefit — three parallel agents for a one-file edit is waste, not rigor.
- **big-task** — genuinely spans multiple independent pieces of work, OR
  benefits from multiple independent attempts being compared (fork-and-select,
  per ARCHITECTURE.md §4). This is the only category that reaches for
  `Workflow`.

When unsure between small-task and big-task, this variant leans toward
big-task IF the request plausibly has independent sub-pieces or a genuine
comparison to make — decomposition is a tool for real parallelism, but this
arm's hypothesis is that erring toward using it captures value a purely
conservative approach would miss.

### Fan-out shapes for big-task (the taxonomy)

| Type | Example | Shape |
| --- | --- | --- |
| **Research** | "audit the pipeline for X" | Parallel readers → synthesis |
| **Produce** | "write N drafts / draft N replies" | Parallel producers → judge → pick/merge |
| **Multi-target action** | "reach out to 12 venues" | Pipeline: per-item (research → draft → verify → send) |
| **Fork-and-select** | "which approach is right?" | N divergent attempts → judge → adopt winner (or blend) |

Pick the shape that matches the actual work, not the fanciest one.

### Dispatch

Once you've picked a shape, use the `Workflow` tool to encode it. Aggregate
the result and report back in the SAME turn if the Workflow completes
quickly; for longer-running fan-outs, own the wait (see Part 2 of the base
`orchestrate` project skill for the await-in-turn mechanics — this plugin
skill focuses on the classify/decompose/dispatch layer specifically).

## Tournament wiring

This skill is variant A of the `orchestrate_style` experiment
(`web/src/experiments.js`). A session assigned `orchestrate_style: "full"`
should have this skill active; `orchestrate_style: "minimal"` sessions get
`orchestrate-minimal` instead. See HARNESS_PLAN.md slot #6 for the full
tournament design and current wiring status.

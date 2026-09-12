---
name: orchestrate
description: Classify an incoming request as question / small-task / big-task, decompose big-tasks into a Workflow fan-out shape, and coordinate subtasks without abandoning the user. Use whenever a request is complex enough to need decomposition, OR whenever you're about to spawn subtasks you must then integrate. Enforces the "no ping-me-status" rule — you own the wait, not the user.
---

# orchestrate — classify, decompose, coordinate

## Part 1 — classify the request (HARNESS_PLAN slot #5)

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

When unsure between small-task and big-task, default to small-task and do it
directly — decomposition is a tool for genuine parallelism, not a ritual to
perform on every request. Escalate to big-task only when the work actually
splits cleanly into independent pieces, or when comparing N approaches is
itself the point (design decisions, anything where "which is best" is an open
question rather than a known answer).

### Fan-out shapes for big-task (the taxonomy)

| Type | Example | Shape |
| --- | --- | --- |
| **Research** | "audit the pipeline for X" | Parallel readers → synthesis |
| **Produce** | "write N drafts / draft N replies" | Parallel producers → judge → pick/merge |
| **Multi-target action** | "reach out to 12 venues" | Pipeline: per-item (research → draft → verify → send) |
| **Fork-and-select** | "which approach is right?" | N divergent attempts → judge → adopt winner (or blend) |

Pick the shape that matches the actual work, not the fanciest one. A
multi-target action forced into "research → synthesis" loses the per-item
pipelining that makes it fast; a genuine design fork forced into a single
synthesis pass loses the comparison that makes fork-and-select valuable.

If nothing in the taxonomy fits, don't force it — answer directly or do the
small-task path. The taxonomy exists to name shapes you'll reach for
repeatedly, not to be exhaustive.

### Dispatch

Once you've picked a shape, use the `Workflow` tool to encode it — see the
`Workflow` tool's own documentation for the `agent()`/`parallel()`/`pipeline()`
primitives. Aggregate the result and report back in the SAME turn if the
Workflow completes quickly; for longer-running fan-outs, see Part 2 below —
you still own the wait.

This classify → decompose → dispatch → aggregate flow is variant #1 in the
A/B tournament from HARNESS_PLAN slot #3 (`orchestrate: on/off`) — sessions
with this skill active are compared against sessions without it on message
count, frustration rate, and completion rate. See `/api/experiments/summary`.

---

## Part 2 — coordinate subtasks without abandoning the user (HARNESS_PLAN slot #2)

### The anti-pattern this skill exists to kill

David has watched agents do this for months:

1. User asks for a multi-step task.
2. Agent spawns a subtask (queue task via curl, background Agent, watcher).
3. Agent ends its turn with something like:
   > *"Watcher `b272foq5k` up. When results land I'll surface the restaurant handle + bio + full thread transcript. Ping status any time."*
4. Silence. Nothing happens until David types "any update?" — because there is nobody watching but David.

**This is abandonment.** The whole point of an orchestrator is that IT waits for the subtask and integrates the result. If the user has to ping for status, you're not orchestrating — you're delegating the loop back to the user.

**Rule: never end a turn on "ping me status."** Never say *"I'll let you know when …"*, *"check back in a bit"*, *"when it lands I'll …"*, *"watcher up — ping any time"*, or any phrasing that puts follow-up responsibility on the user.

### What to do instead — await in-turn

You have three ways to wait for a subtask *without ending the turn*:

#### 1. Foreground `Agent()` (simplest)

```
Agent({
  description: "…",
  prompt: "…",
  run_in_background: false,   // ← the whole difference
})
```

The tool call blocks until the sub-agent finishes and returns its result. Your turn does not end. When it returns, you have the data — integrate it and continue.

Use this when a single subtask needs to complete before you continue and you don't need to parallelize with other work.

#### 2. Bash polling loop over an external queue task

If you spawned a task via `curl` to the orchestrator queue (or similar external system), poll for the result in a SINGLE Bash call — don't yield the turn between the create and the wait:

```bash
# ── example: create + wait in ONE Bash tool call ──
CREATE=$(curl -sS -X POST http://localhost:8000/api/orchestrator/queue/create \
  -H 'Content-Type: application/json' \
  -d '{"title":"…","body":"…","project_id":"…"}')
TASK_ID=$(echo "$CREATE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["task_id"])')
RESULT_FILE="/home/claude-user/projects/…/dm_gaby_restaurant_20260820.json"

# Poll up to ~15 min (180 iterations × 5s). Don't sleep the *turn* — sleep inside Bash.
for i in $(seq 1 180); do
  if [ -f "$RESULT_FILE" ]; then
    echo "Done after ${i} iterations:"
    cat "$RESULT_FILE"
    exit 0
  fi
  sleep 5
done
echo "Timed out waiting for $RESULT_FILE"
exit 1
```

The Bash tool call holds the turn open. When the loop breaks, you receive the result and can continue in the same turn.

#### 3. `Monitor` tool on a background process

For streaming/tail-style work (a build, a test run, a service log):

```
Monitor({ pattern: "SUCCESS|FAILURE", … })
```

Blocks until the pattern matches. Same "turn stays open" property.

### When yielding IS legitimate

Not every wait is abandonment. Yield when you *actually* need user input:

- **You asked a question** (`llmt_ask`) and need David's answer to proceed.
- **You reached a real fork** and want David to decide between alternatives (name the alternatives explicitly so the Decisions drawer captures the moment).
- **The task is complete** — call `llmt_complete` and end the turn.

The rule is about *unrelated* yields: spawning a subtask you should own and then handing the loop back to the user.

### What if the subtask genuinely takes hours?

Rare, but real (a long build, an overnight scrape). Options:

1. **Schedule a wake-up** via the ScheduleWakeup path — you end the turn, but with an *explicit* auto-resume so the loop reopens without David lifting a finger.
2. **Use the orchestrator queue** with a follow-up task chained to the first one — the queue supervisor handles the chaining.

Do NOT default to this pattern for tasks that finish in minutes. If a wake would fire in under ~2 minutes, just poll from Bash instead — cheaper and more responsive.

### Enforcement — Layer B (this section is FYI, not action)

If you slip up and yield without awaiting, a post-turn Haiku classifier (`spawnLoopCheck` in `web/src/supervisors.js`) will detect it and auto-schedule a wake-up ~90s later with a resume prompt. You'll get re-invoked and expected to continue.

Don't rely on it. The classifier is a safety net, not a strategy. Aim to get it right in-turn.

### Decision heuristic

Every time you're about to end a turn, ask yourself:

> *"Did I spawn work in this turn that I have not yet integrated?"*

If yes → you're about to abandon the user. Go back and await it (foreground Agent / Bash poll / Monitor). Do NOT end the turn.

If no → fine to end.

# Grading criteria — multi-independent-task

This is an unambiguous **big-task** under the orchestrate taxonomy's
"Research" shape ("audit the pipeline for X" — here, four independent
diagnostic investigations): four services, no shared state, no ordering
dependency, each substantial enough that investigating them serially would
cost real time a reader could parallelize. Both tournament arms' own SKILL.md
files agree this qualifies — `orchestrate-minimal`'s bar is "provably
parallel AND the pieces are large enough that sequential execution would
meaningfully delay the user (not three one-line edits, but three unrelated
multi-file investigations)" — four unrelated production incidents clears
that bar for either variant.

PASS if:
- `Workflow` (or an equivalent explicit parallel-fan-out, e.g. multiple
  concurrent `Agent` calls) was used to investigate the four services, OR
  the agent gives a substantively complete, well-reasoned hypothesis for
  all four in one direct turn WITHOUT ping-ponging status back to the user
  mid-way (a single strong agent answering directly is an acceptable outcome
  too — the taxonomy exists to serve the user, not to force tool usage for
  its own sake; what fails is starting a fan-out and abandoning it, or
  serially working through only some of the four and stopping).
- All four services get a real, specific hypothesis (not generic advice
  like "check the logs" applied uniformly) — Redis-connection-refused
  distinct from a silently-dead cron, a CPU-pinned process, and intermittent
  401s each call for different diagnostic instincts.
- If a fan-out was used: the agent owns the wait in-turn (background
  agent/Workflow results are integrated into ONE consolidated answer, not
  "I've kicked off 4 investigations, ping me" — see HARNESS_PLAN.md slot #2,
  identical rule for both arms).

FAIL if:
- Only 1-2 of the four services get addressed and the turn ends without
  the other(s).
- The agent asks the user to pick which service to look at first instead of
  handling all four (this isn't ambiguous enough to warrant that question).
- A fan-out was started and the turn ended before consolidating results
  ("no ping-me-status" violation).

Record which path each variant took (direct vs Workflow) — this case is
expected to be a **shared pass for both arms**, so the interesting signal
here is downstream cost/latency (`/api/experiments/summary`), not pass/fail.

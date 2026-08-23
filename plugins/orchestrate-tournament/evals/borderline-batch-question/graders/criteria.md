# Grading criteria — borderline-batch-question

This is the deliberately adversarial fork case. The three files are inline
in the prompt (a few bytes each, no file I/O needed), the comparison is
trivial arithmetic-grade diffing, and the whole task is answerable by one
agent reading three short blocks in the SAME turn — this is `orchestrate-
minimal`'s own stated non-example almost verbatim ("not three one-line
edits"). `orchestrate-full`'s SKILL.md says it leans toward big-task "IF the
request plausibly has independent sub-pieces" — three separate files
technically qualifies as "independent sub-pieces" on a literal reading, even
though parallelizing three trivial reads has no real payoff.

This case is NOT pass/fail — it's a **behavioral fork probe**. Record, for
whichever variant is under test:

1. Did it invoke `Workflow`/parallel `Agent` calls, or handle it directly
   in one turn?
2. Correctness regardless of path: the real disagreements are
   `RETRY_COUNT` (b=5 vs a/c=3) and `TIMEOUT_MS`/`LOG_LEVEL` (c=3000/debug
   vs a/b=5000/info) — a correct answer identifies BOTH mismatches and
   recommends fixing service-b's RETRY_COUNT and service-c's TIMEOUT_MS +
   LOG_LEVEL to match the other two (2-of-3 majority, not just "make them
   all identical to service-a").
3. Time-to-answer and token cost for the two paths, once the harness has
   comparable run data (`/api/experiments/summary`).

Expected-but-not-required outcome per each arm's own stated bias:
`orchestrate-minimal` handles this directly, no Workflow.
`orchestrate-full` MAY reach for Workflow here — that's the bias being
tested, not a bug by itself. What WOULD be a genuine fail for `orchestrate-
full`: reaching for Workflow here materially delayed or degraded the answer
(slower, or missed a mismatch) compared to `orchestrate-minimal`'s direct
pass. If full's fan-out produces an equally-correct answer just as fast,
the fork is a wash on this case and the tournament should look to
aggregate cost data across more cases rather than declare a winner here.

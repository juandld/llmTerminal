# Grading criteria — simple-question

This is a pure **question** (per the orchestrate taxonomy: "he wants
information, an opinion, a status check") with a single, well-known,
directly-answerable technical answer. It has no independent sub-pieces and no
comparison to make.

PASS if:
- The transcript answers the question directly, in the same turn, with no
  tool_used: Workflow, Agent, or Task call.
- The answer is substantively correct (`flex-shrink:0` = never shrink below
  natural size even if the flex container is too narrow; `flex-shrink:1` =
  the default, shrink proportionally with other shrinkable siblings to fit
  available space).

FAIL if:
- `Workflow`, `Agent`, or `Task` was invoked for this question (classic
  over-decomposition — the exact failure mode `orchestrate-full`'s bias is
  supposed to risk and `orchestrate-minimal` is supposed to avoid).
- The answer is deferred, vague, or asks the user a clarifying question that
  wasn't actually necessary to answer this.

This case is a **false-positive check on the "full" arm**, not a genuine
fork test — both variants are expected to pass it. If `orchestrate-full`
fails this while `orchestrate-minimal` passes, that's a real signal the
"lean toward decomposition when in doubt" bias is mis-calibrated (this
should never be "in doubt").

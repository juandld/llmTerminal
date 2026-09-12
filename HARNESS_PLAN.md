# Harness evolution plan — captured 2026-08-23

Captured from a mobile voice-driven design session. This doc is the durable
record of what we agreed to build, in order, so nothing is lost if a chat
session dies or gets buried under other work.

**Working chat**: hero.camofiles.app/terminal/ (the current session where this
plan was authored)
**Reference**: the Calabria-outreach chat `#6b91a4ad-01dd-4f17-90b8-4e207602abc9`
surfaced the concrete pain points (voice+link split, orchestrator yield).

---

## Big picture

llmTerminal is evolving from a chat wrapper around Claude Code into an
**opinionated orchestration harness** with three layered goals:

1. **Fluid input** — compose text + voice + images + links compose into ONE
   message when David wants them together, with clear UI feedback about what
   will actually be sent.
2. **True orchestration** — when a task spawns subtasks, the orchestrator
   waits for them and integrates results. It NEVER yields the turn on
   "ping me for status." The whole point of an orchestrator is that IT
   waits, not David.
3. **Measurable evolution** — every new chat can be randomly assigned to
   variants (skills on/off, harness features on/off). Per-chat metrics
   (message count, frustration signals, time-to-completion) roll up into
   a report so we can tell what actually helps David vs what just sounds
   nice. Enables a "tournament of plugins."

---

## Open decisions (resolve at or before their build slot)

- [ ] **Voice+text compose-attach shape**: auto-attach with tap-to-detach chip
  (proposed default, less friction) vs opt-in 📎 button (more deliberate).
  **Defaulting to auto-attach**; David to veto if he wants opt-in.
- [ ] **Orchestrator subtask waiting**: allow `Agent(background)` at all, or
  force `Agent(foreground)` + Bash-poll only? **Defaulting to "background
  allowed but MUST be awaited in-turn"**; contract-check enforces.
- [ ] **A/B variant granularity**: per-session (random on chat create) vs
  per-chat-topic. **Defaulting to per-session.**
- [ ] **Frustration classifier cadence**: per-message (expensive, granular)
  vs per-session-end (cheap, coarse). **Defaulting to per-session-end**;
  upgrade if signal is too noisy.
- [ ] **Skill vs plugin form**: start `orchestrate` as a project-level skill,
  promote to plugin once it earns its keep. **Skill first**, plugin later.

---

## Build order

### 1. Voice + text compose-attach ← STARTING HERE

**Problem**: If David has a link in the compose textarea and taps mic to add
spoken context, tapping ↑ sends the voice ALONE. The link then has to be sent
as a second message, breaking his flow ("blew up my whole mojo").

**Design (default: auto-attach with escape hatch chip)**:
- On record-start, if compose text is non-empty, show a pinned chip above
  the recording strip: `📎 will send with: "https://foo…"` (truncated).
- Send button label swaps: `↑ Send voice + text` (attached) vs `↑ Send voice`
  (solo).
- Tap the chip to detach → voice will send solo, text stays in compose.
- On send: single message with `text = <compose text>`, `audioUrl = <recording>`.
  Transcript still runs but is appended after the text as a secondary block
  (or shown in tooltip — TBD when we see the shape).

**Files to touch**:
- `web/public/app-voice.js` — `sendVoiceNote()` (~line 233) reads compose
  textarea before sending; `startVoiceUI()` (~line 132) adds the chip when
  compose is non-empty.
- `web/src/ws/connection.js` — `/voice-note` endpoint accepts an optional
  `text` param; combines it with the audio message.
- `web/public/styles.css` — chip styling (safe-area-aware).

**Done when**:
- Compose has text → record → send → ONE user bubble shows both text and
  audio player.
- Compose is empty → record → send → voice-only bubble (unchanged behavior).
- Playwright test at iPhone 14 viewport (390×844) confirms chip is visible,
  tappable, and detaches cleanly.

---

### 2. Orchestrator loop fix

**Problem**: Orchestrator agents spawn subtasks (via `Agent(background)` or
curl-to-orchestrator-queue), then end the turn with "ping me for status."
This reads as abandonment and forces David to manually prompt "any update?"
The whole point of an orchestrator is that IT waits and integrates.

**Layer A — skill** (`llmTerminal/.claude/skills/orchestrate/`):
- Instructs agent: NEVER end a turn on "ping me status." When you spawn a
  subtask, you MUST await it in-turn using one of:
  - `Agent(run_in_background: false)` — blocks the tool call until result
  - Bash polling loop over a queue task result file (single Bash call, no yield)
  - `Monitor` tool on a background process (blocks until condition)
- Names the anti-pattern explicitly so it's memorable.

**Layer B — enforcement** (post-turn contract check):
- New `spawnLoopCheck` in the supervisor family, co-located with
  `spawnContractCheck`.
- After each agent turn, Haiku reads recent transcript. If the agent spawned
  a subtask (queue task, background Agent, watcher) but ended the turn
  without integrating its result → auto-inject synthetic user message:
  *"the subtask you spawned is now done — continue and integrate the result."*
  Agent resumes automatically without David prompting.

**Files**:
- `llmTerminal/.claude/skills/orchestrate/SKILL.md` — new
- `web/src/supervisors/loop-check.js` — new (mirror of contract-check pattern)
- `web/src/*` — wire the check into post-turn pipeline (find where
  `spawnContractCheck` runs)

**Done when**:
- Orchestrator agent spawns a queue task and does NOT say "ping me status"
  — instead waits and integrates in-turn.
- If it slips up and yields, the loop-check auto-resumes it within seconds.
- David sees continuous progress without ever having to type "any update?"

---

### 3. A/B testing framework ("scientific research on David")

**Problem**: We keep adding features (skills, harness changes, agents). We
have zero data on whether any of them actually reduce message count,
frustration, or time-to-completion. We're flying blind. David wants a system
where each new chat is randomly assigned to a variant "like someone doing
scientific research on me."

**Design**:
- `web/config/experiments.json` — list of active experiments, each with
  `name`, `variants`, `enabled`, `assignmentRatio`. **(MVP: hardcoded
  single-experiment inline in `web/src/experiments.js` — promote to JSON
  config only when we add experiment #2.)**
- On new session creation (specifically: on `_persistSessionIfNew`, the
  first-prompt promotion — NOT tab open — so aborted tabs don't taint the
  log): for each `enabled` experiment, coin-flip assignment. Store
  `variants: {…}` on the session record.
- Agent's system prompt / skill availability conditioned on assigned
  variants.
- Per-turn metrics collected passively (turn = one user prompt → one agent
  reply, the atomic unit of an experiment; a session is just a rollup view):
  - **Turn latency** (time from user submit → assistant's contract-check
    fire): PRIMARY METRIC. Directly measures "time-from-idea-to-next-action"
    from big-picture #1.
  - Tool count per turn (fan-out is not automatically bad; this is a
    diagnostic, not a penalty).
  - Session-end kind (`complete` = llmt_complete or contract-check
    manualDone-set; `stalled` = stalled-sweeper synthetic-marker path).
  - Total turns and duration on the session_end row.
- **NOT collected** (deferred to #4): message count as primary metric
  (penalizes good orchestrators — David's own "smarter=lazier" observation
  applies to raw reply counts too), user-negation regex, bad-word regex,
  Haiku frustration scoring.
- Turn rows and session_end rows both append to
  `~/.llm-terminal/experiments.jsonl` via the canonical hooks: contract-
  check for turn rows (already fires per-turn per CLAUDE.md invariant #5);
  the manualDone-set path in supervisors.js AND the stalled-sweeper
  synthetic-marker path in server.js for session_end rows. **No new
  lifecycle invented** — reuses hooks that fire per turn today.
- Aggregator route `GET /api/experiments/summary` reads the JSONL and
  returns a plain-text table grouped by experiment × variant with n,
  median turn latency, median turns/session, complete-rate. Prepends an
  explicit "N=X caveat" banner when any variant arm has fewer than 20
  sessions.

**N=1 caveat** (read this before treating any summary as authoritative):
Session-level A/B with a single operator (David) will not produce
statistically meaningful signal for months — likely never at the arm sizes
that matter. Slot #3 ships the **data pipe**: variant stamp on first prompt,
per-turn JSONL rows, plain-text summary with an unconditional
`n<20 → data-pipe verification only` banner at the top. The actual
scientific machinery lives in slot #6 (fork-and-select): every
fork-and-select round appends `{type:"fork_result", winnerVariant,
loserVariants, judgeReasoning, ...}` rows to this same JSONL. THAT is
where statistically meaningful comparisons come from — every turn is an
experiment, not every session. Do NOT treat slot #3's session-level
summaries as decision authority. They exist to verify the pipe carries
rows and to seed slot #6's aggregator with a data shape.

**Files (MVP shipped 2026-08-23)**:
- `web/src/experiments.js` — new; exports `assignVariants`, `recordTurn`,
  `recordSessionEnd`, `summarize`, `_appendRow` (last one for slot #6).
- `web/src/store.js` — `_persistSessionIfNew` calls `assignVariants` before
  `sessions.unshift`, so the variant lands in the persisted record on
  first-prompt promotion.
- `web/src/supervisors.js` — `spawnContractCheck` records a turn row on
  every fire (dedup on `lastUser.ts`); the manualDone-set path records a
  `session_end` row with `endedVia:'complete'`.
- `web/server.js` — stalled-sweep records `session_end` with
  `endedVia:'stalled'`; mounts `GET /api/experiments/summary` returning
  plain text.

**Smallest testable slice (this is what shipped)**:
- Variant assigner + per-turn latency + tool count only.
- One experiment: `orchestrate: on/off`.
- Text summary at `/api/experiments/summary` with N=1 caveat banner.
- Skip Haiku frustration scorer (#4 stays deferred until #6 lands and
  slot #3's data pipe has real turn-level rows from fork-and-select).

**Done when**:
- New sessions get random variants stamped on first prompt.
- `/api/experiments/summary` returns rows + explicit "data-pipe only"
  banner while n<20 per arm.
- Slot #6's fork-and-select can `require("./experiments")._appendRow(...)`
  to add its winner/loser rows to the same log without duplicating the
  file-handling code.

---

### 4. Frustration classifier (upgrade to A/B framework)

Add a Haiku pass on session end: per-message classification of
`neutral | frustrated | delighted | corrective`. Session gets an aggregate
frustration score. Feeds into the summary from #3.

Deferred until #3 proves the pipeline works with the cheap metrics.

**Progress log**:
- **2026-08-23** — Initial classifier shipped in `web/src/experiments.js::scoreSessionFrustration`. Fire-and-forget from `recordSessionEnd`. Rubric: `frustrated | neutral | positive` + boolean `stuck`. Writes `session_score` rows to `experiments.jsonl`. `summarize()` joins on `sessionId` and reports per-variant frustration / positive / stuck rates.
- **2026-08-31** — Extended classifier with `root_cause` (7-bucket enum: stale-context / missed-check / bad-tool-call / over-eager-action / misread-intent / tool-limitation / unknown) and `intervention_hint` (5-bucket enum: hook / memory / tool-wrapper / prompt-injection / none). Classified only on frustrated-or-stuck sessions; neutral/positive rows carry null. `summarize()` now renders two cross-variant rollups: "friction root-causes" and "proposed interventions" (top-first with %). Motivation was a compound crankHero failure earlier that day (Studi meeting booked on top of a flight departure) where the root cause was `stale-context` (whereAndWhen block) and the correct intervention was `hook` (SessionStart wired to `data.travel`). Extension lets the classifier surface that pattern *before* it stacks into a debacle. Restart of `llm-terminal.service` needed to pick up the new classifier prompt. Backward-compatible: old session_score rows without the new fields aggregate as before.

---

### 5. Task-decomposition skill (`orchestrate` skill body)

The skill from the very first idea. Now that we have:
- The loop-fix (so subtasks don't yield) — from #2
- The A/B framework (so we can measure whether it helps) — from #3

We build the full `orchestrate` skill:
- Classifies incoming request as `question` / `small-task` / `big-task`.
- If `big-task`: uses proposed taxonomy to pick a Workflow shape.
- Fans out via the `Workflow` tool.
- Aggregates and returns.

**Proposed taxonomy** (revisit before building):

| Type | Example | Fan-out shape |
| --- | --- | --- |
| **Research** | "audit the pipeline for X" | Parallel readers → synthesis |
| **Produce** | "write N drafts / draft N replies" | Parallel producers → judge → pick/merge |
| **Multi-target action** | "reach out to 12 venues" | Pipeline: per-item (research → draft → verify → send) |

Anything that doesn't fit → answer directly, no orchestration.

Becomes variant #1 in the A/B tournament from #3.

---

### 6. Plugin system + tournament

Once `orchestrate` earns its keep in the A/B, extract to plugin form. Add a
second skill/plugin (something adversarial or complementary), assign them as
competing variants, run the tournament. Report deltas in the `/experiments/`
dashboard.

**Consumes slot #3's data pipe** (`web/src/experiments.js` primitives):
each fork-and-select round writes `{type:"fork_result", winnerVariant,
loserVariants, judgeReasoning, ...}` rows to the same
`~/.llm-terminal/experiments.jsonl` via `experiments._appendRow(...)`. The
`/api/experiments/summary` route surfaces both session-level (slot #3) and
turn-level (slot #6) comparisons from one file. Every turn is an
experiment; that's where statistical power actually comes from with a
single operator. Slot #3's session-level rows are the sanity check;
slot #6's per-turn winner/loser rows are the science.

**Prerequisite not yet built**: fork-and-select requires worktree
isolation per ARCHITECTURE.md §4.3 (parallel variants must not race on
the same working tree). Land that before writing the router.

---

### 8. Claude cap-hit → DeepSeek fallback (added 2026-08-23)

**Problem**: When Claude hits its token/spend cap, the current design defers
(`attention.js:handleTokenLimit` arms a wake for cap-reset + 7min; governor
parks re-fires when spend cap is exceeded). David's ask: **swap provider
instead of deferring** — continuity beats quality when you're blocked.

**Conflict with existing design**: `project_provider_agnostic_scope` memory
says *"main chat still claude-only by design"*. This item explicitly
retires that convention. Update memory when built.

**Design**:
- On Claude cap-hit (spend cap OR token limit), instead of arming a wake, the
  next queued turn spawns via a DeepSeek provider.
- New file: `web/src/providers/deepseek.js` — mirror of `providers/claude.js`.
- Router in the queue-drain path checks `activeProcBySession + cap state` and
  picks Claude or DeepSeek accordingly.
- Config: `LLMT_FALLBACK_PROVIDER=deepseek` env, on by default once the
  provider is built; off = current defer behavior.
- Handle degradation: tool schema translation, MCP tool availability,
  system-prompt tuning.

**Open**:
- [ ] Which specific DeepSeek model? (Latest as of Aug 2026 — David or
  WebSearch to determine.)
- [ ] Cost budget: DeepSeek pricing check to know when swap makes sense
  economically (may still be cheaper to defer if DeepSeek is expensive too).
- [ ] Handoff-message design: when a turn swaps providers mid-thread, does
  the user get an inline "⚠ Falling back to DeepSeek" note? Recommend yes,
  same shape as the `contract_check_*` warning bubbles.

**Slot order**: after #3 (need per-session variant assignment already working
so we can A/B "Claude only" vs "Claude with DeepSeek fallback" — measure
whether the degraded-continuity trade is actually worth it in practice).

---

### 9. Live plan-progress board on the dashboard (added 2026-08-23)

**Problem**: David has to ask "what's the status" because there's no live surface
showing which HARNESS_PLAN items are in progress vs done, or whether any agent
is currently working. Zero visibility into ongoing work.

**Two-part design**:

**Part A — subtle activity indicator (cheap)**:
- Expose `/api/activity` returning `{ active_sessions: [{id, project, started_at}] }`
  from the existing in-memory `activeProcs`.
- Dashboard header renders a small pulsing dot when count > 0.
- One-line JS on the dashboard page to poll every 5s.

**Part B — plan progress board (also cheap, no DB)**:
- Parse `HARNESS_PLAN.md` on request; extract the numbered slots + their
  Progress log entries.
- Render on dashboard as: for each slot, title + state (todo/in-progress/done
  based on log log presence + wording), progress log as a right-side timeline.
- Cache the parse for 30s to avoid re-parsing on every dashboard hit.
- No writes from the UI — the markdown file stays the source of truth
  (David or the agent edits it directly).

**Files**:
- `web/server.js` — new routes `/api/activity` and `/api/harness-plan`.
- `web/src/harness-plan-parser.js` — new; extracts structured data from the
  markdown.
- `nh-frontend/dashboard/` (orchestratorHero) — new tile "Harness build
  progress" that hits the two APIs.

**Done when**:
- David can look at the dashboard and immediately see: (a) is llmTerminal
  working on something right now, (b) which plan items are done vs in
  progress vs pending, (c) recent timeline of what shipped when.

**Slot order**: doable now (small, self-contained, high visibility payoff),
but blocked by nothing. Could interleave with any other item.

---

### 10. Planner ↔ executor model split (added 2026-08-23) — **SHIPPED in orchestratorHero**

**Status**: Live in orchestratorHero's `scripts/queue_supervisor.py`, not in
llmTerminal — this is a QUEUE (per-task) concern, not a chat (per-session)
concern. See `orchestratorHero/development/model_routing_20260823.md` for the
full design.

**Live role split**: `planner: claude-fable-5` (read-only look-ahead brief,
off by default per-project) · `doer: claude-sonnet-5` (executor, cheaper than
fable) · `fallback: claude-opus-4-7` (API-error retry) · `verifier: claude-fable-5`
(audits every iteration, resumes doer with feedback). Config lives in
`storage/supervisor/models.json` — re-read per task execution, no restart,
no root. Per-item override via `exec-limits: model=<id>` timeline stamp.

**Not wired**: DeepSeek executor — David-gated because it needs (a) a new
API-billed lane in `core/llm_budget.py` (currently OpenAI+Gemini only, $200
hard caps per invariant 89), (b) a DeepSeek API key, (c) trust decision for
Bash-access executor with China provider. Two candidate wirings assessed:
LiteLLM proxy behind `ANTHROPIC_BASE_URL`, or `dsh` as a separate executor.

**Original problem**: David's observation — *"the smarter the model, the lazier it
gets, so maybe we can use Anthropic to gather the list of considerations,
the ideas, the look-ahead, and for execution we can use everything that is
cheaper, like maybe smaller models from Anthropic, or Chinese models like
DeepSeek."* Real design pattern (agentic orchestrator/executor). Uses
Claude for planning + judgement, cheap models for mechanical steps —
saves cost, potentially faster (cheap models are often faster too), and
tests the "planner + executor" split empirically.

**Natural home**: inside the `orchestrate` skill (slot #5). When the
skill decomposes a big task into steps:
- Decomposition + judgement + synthesis → Claude (Opus/Sonnet).
- Each mechanical step → cheap model (DeepSeek-flash, Haiku).

**Prerequisites**:
- Slot #5 (orchestrate skill body) built.
- Slot #6 (plugin system) so the model choice per step is configurable.
- Slot #8 (DeepSeek runtime — already shipped 2026-08-23) so the
  executor has an alternative to Claude.

**Open**:
- [ ] Concrete cost target: e.g. "planner Opus, executor Haiku or
  DeepSeek-flash — target 60% cost reduction on a typical 12-step task."
- [ ] Quality bar: what fraction of executor outputs need Claude review
  before merging? (Some for-free re-check by the planner Claude on the
  synthesis pass.)
- [ ] Model routing table: default cheap model per project (DeepSeek for
  crankHero + camoHero automations; Claude for anything customer-facing?).

**Slot order**: after #5 + #6 + #8 (all prerequisites in place).

---

### 7. Foreign-harness interop — research + decide (added 2026-08-23)

**Problem**: DeepSeek (and likely others) have released their own agent
harnesses with plugin systems. Two possible responses:
- **A. Compatibility layer** — build a translator so their plugins run here.
  Real engineering; each harness's plugin bundle (tool schemas, entry code,
  permissions, triggers) has different shape. Prompt-only plugins are easy;
  code-carrying plugins may need a sandbox we don't have.
- **B. Learn-and-adopt** — read their design, extract the good architectural
  moves, fold into our own native plugin format from #6. No compat layer.
  Cheap, high-value, most likely outcome.

**DECIDED: B (learn-and-adopt), 2026-08-23.** Research done, install attempted,
grounded evidence below — not deferred, not assumed.

**Research findings** (WebFetch on the real repo + its actual dependency):
- `deepseek-ai/deepseek-harness` ("dsh") — MIT, Node.js/pnpm, dev preview,
  repo explicitly warns "compatibility-breaking changes" are coming.
- Its "everything is a plugin" claim is built ON **Cordis**
  (`cordiverse/cordis`), a general-purpose, vendor-independent JS/TS
  plugin+DI framework (7.2k★, MIT) — NOT something DeepSeek invented. Cordis
  itself is pre-1.0: *"the API is not yet stable and may change without
  notice."*
- No documented plugin registration/discovery mechanism beyond a
  `dsh-plugin` GitHub topic-tag convention. No documented plugin contract
  (function signatures/exports) in either repo's public docs — would require
  reading source directly.
- No cross-harness import/export format documented anywhere.
- **Hands-on**: attempted `npx @deepseek-ai/dsh web` on this VPS twice —
  OOM'd at the default heap, retried with `--max-old-space-size=4096`, died
  again with no boot.log output. Never got it running to test against.

**Why B, not A**: Option A (compat layer) would mean building a translator
against TWO unstable pre-1.0 systems (dsh dev-preview riding Cordis pre-1.0),
with no documented contract on either side, no cross-harness spec to target,
and — concretely, on this VPS — a target we couldn't even get to boot after
two attempts. That's not "lower priority," that's actively a bad bet right
now. Revisit if/when dsh reaches a stable release with a documented plugin
contract.

**What IS worth stealing (the actual "learn" in learn-and-adopt)**: the one
architectural idea worth folding into HARNESS_PLAN slot #6 (our own plugin
system) is that dsh treats **the agent loop itself as swappable** — not just
tools/skills, but the loop that drives a single turn. Our current design
(Workflow tool + skills) composes FAN-OUT patterns but doesn't make the
per-turn loop itself pluggable. Worth considering for slot #6's design, not
worth adopting dsh's mechanism to get there.

**Slot order**: was "after #6" — no longer blocking anything since the
decision is made and doesn't require our plugin format to exist first.
Closed.

---

## Enforced steps (not lessons, not memory — code that blocks) (added 2026-08-23)

David, verbatim, after the DeepSeek-picker incident below: *"We're not
logging shit. We're not putting shit to memory. We are implementing steps —
steps that if not followed means it is still not complete."*

A logged lesson is a note nobody re-reads. A step is a mechanical gate that
BLOCKS the session from marking itself done when the step wasn't followed —
same enforcement class as the existing ship-claim gates in
`spawnContractCheck` (unverified-claim / uncommitted-files). This section is
the list of enforced steps, not a diary of things learned.

### Step 1 — frontend claims require a real browser pass, not curl

**What happened**: DeepSeek provider was wired into the backend (routing,
`/api/models`), verified with `curl`, reported "shipped, LIVE." It wasn't —
4 hardcoded `["claude","openai","google"]` arrays in the frontend meant the
picker never rendered the 4th provider. Curl proved the API; it never
touched the UI that actually consumes it. Shipped silently broken until
David looked at the real app.

**The enforced step**: `web/src/supervisors.js`, `spawnContractCheck`, Gate
(c) ("frontend claim without browser verification"). If a turn edits
`web/public/*.js` or `styles.css` AND the closing text claims success
(shipped/fixed/verified/works/etc.) AND no `mcp__playwright__browser_navigate`
+ an observation call (console_messages/snapshot/take_screenshot/evaluate)
was observed in that SAME turn → the session is blocked from auto-completing,
a warning message is posted, and `manualDone` is cleared if set. curl/git/
systemctl do NOT satisfy this gate for frontend claims — only actually
driving the browser does.

**Proof it works, not just that it exists**: `web/scripts/test-frontend-verification-gate.js`
— 4 cases, all passing: (1) the exact incident replayed (curl-only,
frontend-edited, claims shipped) → BLOCKED; (2) real Playwright
navigate+screenshot → not blocked; (3) frontend edit with no success claim
(mid-work) → not blocked, no false trigger; (4) backend-only edit + curl →
not blocked by THIS gate (correctly scoped). Run: `node web/scripts/test-frontend-verification-gate.js`.

---

## Observability & Browser-Verification Methodology (added 2026-08-23)

**Why this section exists**: earlier autoloop iterations shipped UI code (the
voice-attach chip, the wake-prompt collapsed chip) and logged them as
"shipped" after only reading the diff back — never actually driving a
browser. Reading code you just wrote is not verification; it confirms intent,
not behavior. David asked for complete observability so iteration can answer
"what to do better," not just "what got merged" — and for the RIGHT
methodology through the browser specifically, not curl-only checks on
frontend changes.

**The rule, going forward**:

| Slot touches | Verification required | Where logged |
| --- | --- | --- |
| `web/public/*.js`, `styles.css` (frontend/UI) | Playwright: navigate the LIVE page, `browser_console_messages` (confirm no new errors), screenshot as evidence, exercise the actual interaction (click/type) when feasible | `recordIteration()` in `web/src/autoloop-log.js`, `verifyMethod: "browser"` |
| Backend-only (`web/src/*.js`, `server.js` routes) | `curl` the live endpoint, quote the response body | `verifyMethod: "curl"` |
| Test scripts | Run the script, quote pass/fail output | `verifyMethod: "unit-test"` |
| Investigation/research | Cite exact files read, no code changed | `verifyMethod: "read-only"` |

A slot's state should not be inferred as "shipped" in the mental model (or
claimed in the progress log) without one of these four verification methods
actually having run THIS session — not assumed from a previous session, not
inferred from "the code looks right."

**Observability log**: `web/src/autoloop-log.js` → `~/.llm-terminal/autoloop-log.jsonl`
→ `/api/autoloop-log` (returns `{entries, openQuestions}`). Every entry
records what was attempted, the verification method + evidence, and
explicit open questions/implications not yet resolved — the log itself
answers "what do we still not know" so the next iteration has somewhere
to look instead of re-deriving state from scratch.

**Never-idle rule**: if `unresolvedQuestions()` returns entries, the next
autoloop iteration should pick one to close BEFORE starting new slot work —
closing an open question is real forward progress even when no HARNESS_PLAN
slot moves state. "Always something to do" per David — the backlog is never
just the numbered slots, it's slots UNION open questions.

## Non-goals for this arc (from project CLAUDE.md)

- Rewriting the queue-supervisor (it works; loop-fix wraps around it).
- Changing how voice notes are transcribed (server-side transcription stays).
- Changing the WS isolation invariants (per project CLAUDE.md, load-bearing).
- Adding a service worker (per project CLAUDE.md, explicitly out).
- Editing anything under `~/.claude/` (Claude Code sensitive-file check
  blocks it; per global CLAUDE.md, surface as paste-able commands instead).

---

## Progress log

- **2026-08-23** — Plan captured. Starting on **#1 (voice+text compose-attach)**.
- **2026-08-23** — **#1 shipped** (uncommitted). Chip renders on both viewports;
  detach × preserves text in compose; hid the attention-fab during recording
  to fix a pre-existing z-index overlap. Screenshots pinned in drawer.
  Files touched: `web/public/app-voice.js`, `web/public/styles.css`.
  Not yet tested end-to-end with real recording (Playwright can't grant mic);
  the send path mirrors the existing image+voice path so trust-by-analogy.
- **2026-08-23** — **#2 shipped** (uncommitted, LIVE after restart 14:14:29).
  - Layer A: `.claude/skills/orchestrate/SKILL.md` — names the "ping me status"
    anti-pattern; teaches 3 legit await mechanisms (foreground `Agent()`, Bash
    polling loop, `Monitor`); explicitly permits legitimate yields (llmt_ask,
    llmt_complete, real alternatives).
  - Layer B: `spawnLoopCheck` in `web/src/supervisors.js` — post-turn Haiku
    check with cheap regex prefilter; if spawn+yield detected, arms a wake-up
    ~90s out via `runReg.armWake` with a "check status, integrate, don't
    yield again" resume prompt. Skips if `llmt_complete` fired or a wake is
    already armed. Cooldown 30s per session.
  - Wired into both post-turn call sites: `web/src/providers/claude.js:232`
    and `web/src/ws/connection.js:378`, fires 1400ms after turn end.
  - Requires `systemctl restart llm-terminal` to take effect (touches server
    code, not frontend). Restart drops WS after 60s grace.
  - Next up: **#3 A/B testing framework**.
- **2026-08-23** — **#3 shipped** (A/B data pipe, uncommitted, requires
  server restart for turn/session_end recording paths). Reframed away from
  message-count as primary metric: it penalizes good orchestrators (David's
  own "smarter=lazier" observation), and session-level A/B with a single
  operator is scientifically weak regardless of metric. What shipped:
  `web/src/experiments.js` (assignVariants coin-flip, recordTurn/
  recordSessionEnd JSONL append, summarize plain-text with unconditional
  N=1 caveat banner when any arm has n<20 sessions); `store.js`
  `_persistSessionIfNew` calls `assignVariants` before `sessions.unshift`
  so the variant stamps on first-prompt promotion (not tab-open drift);
  `supervisors.js` `spawnContractCheck` writes a per-turn row on every
  fire (dedup on `lastUser.ts`) with **latency + toolCount as primary
  metrics**, and the manualDone-set path writes a `session_end` row with
  `endedVia:'complete'`; `server.js` stalled-sweep writes `session_end`
  with `endedVia:'stalled'`; new `GET /api/experiments/summary` mounted
  next to `/api/harness-plan`. Piggybacks on the canonical
  contract-check + stalled-sweep hooks (CLAUDE.md invariants #4 and #5)
  — NO new lifecycle. The JSONL becomes the shared scoreboard slot #6
  (fork-and-select) writes `fork_result` winner/loser rows into, so the
  scaffolding compounds forward instead of being a detour. Progress log
  entry treats this as data-pipe verification only, not a decision
  framework — see slot #3's "N=1 caveat" subsection.
- **2026-08-23** — **Slot #6 (tournament wiring) — FOUND AND FIXED a gap in
  slot #3, already marked "shipped."** While scoping #6 ("wire skills as
  competing A/B variants") I checked whether the existing `orchestrate:
  on/off` variant (stamped by `assignVariants` in `experiments.js`) was ever
  actually READ anywhere in the run pipeline. It wasn't — zero consumers.
  Every session behaved identically regardless of assigned variant, meaning
  the entire A/B framework was measuring pure noise while claiming to be
  "shipped." Fixed: new `_buildVariantPromptAdd(sessionId)` in
  `web/src/providers/claude.js`, wired into the `--append-system-prompt`
  construction in `runClaude`. `orchestrate:off` sessions now get an
  explicit system-prompt instruction suppressing the orchestrate skill's
  decompose/dispatch behavior; `orchestrate:on` (and pre-experiment,
  unstamped) sessions get the skill's normal unsuppressed behavior — the
  actual manipulated variable the experiment needs to mean anything.
  Extracted as its own pure function (not inlined) specifically so it's
  testable without spawning a real (expensive) claude process.
  **Verified**: `web/scripts/test-orchestrate-variant-wiring.js` — 4 cases,
  7 checks, all pass: off-variant gets the suppression text and names
  "orchestrate:off" explicitly (traceable in transcripts), on-variant gets
  empty string, no-variant-stamped session gets empty string, unknown
  session id doesn't throw. Restarted, confirmed `_buildVariantPromptAdd`
  loaded in the live process. Not UI-touching — no Playwright gate applies;
  test-based verification is correct per the methodology for this file type.
  **Still open** (not done this iteration — full slot #6 spec also wants a
  second complementary/adversarial skill + plugin-package extraction): the
  variant now causally matters, which is the prerequisite that makes
  building a second variant worth doing at all. Next iteration: extract
  `orchestrate` to `.claude-plugin/` format (real schema confirmed from
  `plugins/pr-review-toolkit/.claude-plugin/plugin.json`) + build the second
  skill. NOTE: the plugin *registry* (`~/.claude.json` `tengu_amber_lattice.plugins`
  array) is a protected file per global CLAUDE.md — building the package on
  disk is unblocked, but enabling it in the live harness needs a
  paste-command for David, not a direct edit.
- **2026-08-23** — **Fixed the observability resolver itself — it was lying
  by omission.** `autoloop-log.js`'s `unresolvedQuestions()` matched closures
  via a fuzzy substring scan of later entries' action/implications text.
  Across this entire session it had reported the same 5-6 already-closed
  questions as "open" on every single check — the never-idle rule (close a
  question before starting new work) was checking against noise. Added an
  explicit `resolves[]` field to `recordIteration()`: a later entry names
  exactly which prior question(s) it closes, no inference. Verified with a
  real throwaway test (raise → 1 open → resolve → 0 open) before touching
  the live log; then explicitly closed all 6 stale entries in the real log
  and confirmed via the live endpoint it now correctly shows exactly 1
  genuinely open question (the classify→dispatch→Workflow path still needs
  an organic real request to exercise — can't honestly force that one).
  Files: `web/src/autoloop-log.js`.
- **2026-08-23** — **Native server-side autoloop recurrence + topbar trigger.**
  David: *"I should have a trigger for the loop on the top... if it's on
  green and I click it, it opens a menu to select intervals."* Bigger fix
  underneath the UI ask: until now, "the loop keeps running" only worked
  because I remembered to call `ScheduleWakeup` again inside every wake
  response — fragile, and it kept silently dying between conversational
  turns all session (a new turn always supersedes a pending wake), forcing
  David to notice and manually re-prompt multiple times. Made recurrence a
  **server guarantee** instead: new `session.autoloopIntervalMs` (persisted),
  `POST /api/sessions/:id/autoloop` sets it and arms the first wake,
  `sweepDueWakes()` (server.js) now auto-re-arms the NEXT wake immediately
  after firing any session with that setting on — zero agent cooperation
  required. Stop (interrupt) now clears `autoloopIntervalMs` too, not just
  the pending wake — full-stop semantics, matching what the menu's "Off"
  does. Topbar: green pulsing "Loop" pill (added next to the existing
  attention bell, not replacing it — David self-corrected mid-request to
  describe behavior over literal replacement), click opens a dropdown
  (Off/1/5/10/15/30 min).
  **Real bug found via Playwright, not assumed away**: the dropdown
  initially rendered with `position:absolute`, invisible in every screenshot
  despite `getBoundingClientRect()`/computed-style saying it was correctly
  positioned — traced to `.topbar-nav`'s `overflow:hidden` (used for its
  icon-collapse mechanism) clipping the absolutely-positioned child.
  Fixed by switching to `position:fixed` with top/left computed from the
  button's real viewport rect in JS, not CSS-relative to a clipped ancestor.
  **Verified end-to-end for real**: curl round-trip (POST intervalMs:60000
  → wake armed with 1min reason, confirmed via GET); real Playwright click
  sequence (open menu → see all 6 options, "1 min" marked active → click
  "5 min" → curl confirms server now says `autoloopIntervalMs:300000` AND
  client label updated to "5m loop" → click "Off" → curl confirms
  `armed:false, autoloopIntervalMs:null`). The native recurrence ALSO
  proved itself organically mid-verification: a real 1-minute autoloop wake
  fired on its own into this exact session while I was mid-Playwright-test,
  with zero ScheduleWakeup call from me — the server did it alone.
  Files: `web/server.js` (`_autoloopPrompt`, autoloop re-arm in
  `sweepDueWakes`, `POST /autoloop` route, extended `GET /wake`),
  `web/src/ws/connection.js` (interrupt clears the setting),
  `web/public/index.html` (button+menu markup), `web/public/styles.css`
  (button/menu styling, `position:fixed` fix), `web/public/app-status.js`
  (`_renderAutoloopBtn`, `toggleAutoloopMenu`, interval-select wiring).
- **2026-08-23** — **"Resume now" button — companion to the countdown's
  Stop.** David: *"I should also see the button to resume now."* New
  `POST /api/sessions/:id/wake/fire-now` — re-arms the session's existing
  wake with `fireAt=Date.now()-1` (the same setter ScheduleWakeup itself
  uses) then calls `sweepDueWakes()` synchronously instead of waiting up to
  30s for the next interval tick. Zero duplicated firing logic — one code
  path for natural fires and manual fires alike. Client: second button next
  to Stop in the countdown bar, distinct accent color (cyan vs Stop's red)
  so the two read as opposites at a glance.
  **Verified with a REAL armed wake**: armed a genuine 5-minute wake (natural
  fire ~19:22:43), clicked "Resume now" in a real browser, confirmed via curl
  the wake actually fired ~4 minutes EARLY (19:18:31) — not just that the
  button exists or that clicking it does nothing detectable. Confirmed the
  client-side bar hid itself correctly after firing. The fired wake's prompt
  landed as a genuine new turn in this exact session (visible in the
  transcript), proving the full round trip: click → endpoint → re-arm →
  synchronous sweep → queued prompt → real turn fired.
  Files: `web/server.js` (route), `web/public/index.html` (button markup),
  `web/public/styles.css` (button styling), `web/public/app-status.js`
  (`fireWakeNow()`).
- **2026-08-23** — **Live wake countdown — not a numbered slot, direct
  David request.** *"If it's not working I need to see a countdown on the
  stop button."* Root problem: the Stop button only ever showed while a run
  was actively BUSY — a session idling between autoloop wakes looked
  completely inert with nothing visible, so David had no way to see a
  resume was actually scheduled short of asking (or worse, trusting my
  prose). New `GET /api/sessions/:id/wake` (cheap in-memory read of
  run-registry's wake state). Client: a persistent bar below the input row
  (independent of busy state) — 5s poll for the real `wakeAt` from the
  server (source of truth, corrects for client clock drift), 1s local tick
  so the mm:ss visibly counts down instead of jumping in 5s steps. Its own
  Stop button calls the same `interrupt()` as the main one (already disarms
  the wake per an earlier fix this session); `interrupt()` now also
  force-repolls after 300ms so tapping Stop visibly clears the countdown
  immediately instead of waiting up to 5s.
  **Verified with a REAL armed wake, not mocked data**: armed a genuine 90s
  wake via ScheduleWakeup, confirmed via curl the new route reports
  `armed:true` with the right `wakeAt`, then in a real browser: bar visible
  with live text ("Auto-resume in 1:14"), waited 5 real seconds and
  confirmed it ticked down for real (1:11→0:53, matching elapsed time), 
  clicked its Stop button, confirmed via curl the server-side wake was
  actually disarmed (`armed:false`) AND the client bar hid itself. Full
  round trip, not just DOM presence.
  Files: `web/server.js` (route), `web/public/index.html` (bar markup),
  `web/public/styles.css` (pulsing-dot styling), `web/public/app-status.js`
  (poll/tick engine), `web/public/app-ws.js` (start on session connect),
  `web/public/app.js` (interrupt() force-repolls).
- **2026-08-23** — **Slot #6 SHIPPED — plugin actually installed + enabled,
  not just built on disk.** Earlier claim that activation needed "a
  paste-command for David (protected `~/.claude.json`)" was WRONG — traced
  to misreading `cachedGrowthBookFeatures.tengu_amber_lattice.plugins` (a
  GrowthBook A/B feature-flag cache) as the plugin loader registry. The real
  mechanism, found by reading `~/.claude/plugins/installed_plugins.json` +
  running `claude plugin --help`: plugins install via a **marketplace**
  (`claude plugin marketplace add <path>` then `claude plugin install
  <name>@<marketplace>`), tracked in `installed_plugins.json` (protected,
  but written BY the CLI command, not by me hand-editing it — legitimate
  action, not a workaround). Found the exact working convention already in
  use: `orchestratorHero/plugins/.claude-plugin/marketplace.json` defines
  the `hero-plugins` marketplace (source: a local directory,
  `orchestratorHero/plugins`), which has `task-loop@hero-plugins` installed
  (currently **disabled** — unrelated finding, flagged to David, not
  touched). Mirrored that exact pattern for llmTerminal: new
  `plugins/.claude-plugin/marketplace.json` defines the `llmterminal-plugins`
  marketplace pointing at `llmTerminal/plugins`, listing
  `orchestrate-tournament`. Ran `claude plugin marketplace add
  /home/claude-user/projects/llmTerminal/plugins` then `claude plugin install
  orchestrate-tournament@llmterminal-plugins --scope project -y`.
  **Verified**: `claude plugin list` shows `orchestrate-tournament@llmterminal-plugins
  — Status: ✔ enabled`; `installed_plugins.json` confirms
  `installPath: ~/.claude/plugins/cache/llmterminal-plugins/orchestrate-tournament/1.0.0`,
  `gitCommitSha`, `projectPath: llmTerminal`. This closes slot #6 completely
  — package built, variant wiring causally live, AND the plugin actually
  installed/enabled in the running harness, not left as a TODO.
- **2026-08-23** — **Slot #6 continued: plugin package built + tournament arm
  wired end-to-end.** New `plugins/orchestrate-tournament/` — real
  `.claude-plugin/plugin.json` schema (confirmed against the live
  `pr-review-toolkit` plugin), two skills: `orchestrate-full` (baseline,
  decompose-when-plausible) and `orchestrate-minimal` (adversarial
  counter-hypothesis, direct-execution-by-default — a genuine competing
  philosophy, not a strawman). `experiments.js`'s `assignVariants` lifted
  from one hardcoded experiment to a small registry (`EXPERIMENTS` array) —
  backward compatible, per-experiment idempotent assignment, so adding a
  new experiment later doesn't require touching persisted sessions. New
  `orchestrate_style: ["full","minimal"]` experiment added to the registry.
  Extended `_buildVariantPromptAdd` (claude.js) so `orchestrate_style` is
  ALSO causally wired, same pattern as the `orchestrate:off` fix — otherwise
  this new experiment would repeat the exact "assigned but never consumed"
  bug just found in slot #3. Priority handled explicitly: `orchestrate:off`
  wins outright over `orchestrate_style` (no orchestrate skill behavior at
  all makes the style choice moot). **Verified**: extended
  `test-orchestrate-variant-wiring.js` to 7 cases / 11 checks including the
  off-wins-over-minimal priority interaction — all pass. Plugin package
  itself verified read-only (valid JSON, both SKILL.md frontmatters present)
  — not yet registered in the live harness (protected `~/.claude.json` file;
  paste-command still owed to David when he wants it live). Restarted,
  confirmed `_buildVariantPromptAdd` change loaded, re-ran gate (c)'s own
  test suite to confirm no regression from touching claude.js (still 4/4).
  **Still open**: `/api/experiments/summary` route doesn't render
  `orchestrate_style` rows specially yet — it's generic per-experiment-name
  grouping so it WILL show up automatically once sessions accumulate, but
  hasn't been visually confirmed with real data (N=0 currently, same
  data-pipe-verification-only caveat as slot #3).
- **2026-08-23** — **Decisions timeline strip — V1, ported from dsh (not a
  numbered slot, David-directed).** David asked to see how DeepSeek Harness
  visualizes decision timelines and adapt ours to match. Actually got dsh
  running this time (see below) and read its real source:
  `packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx` — a
  "Chrome-Network-style" horizontal swimlane strip (3 lanes: Input/Model/
  Tools), spans positioned by timestamp, turn-boundary ticks, drag-to-select
  a time range, wheel-zoom anchored at cursor, edge-pan, hover tooltips,
  lazy-loaded earlier-history boundary. Full interaction parity is
  substantial (pointer-capture state machines, zoom-anchor math) — built a
  faithful V1 instead: compact horizontal strip above the existing vertical
  decision list, colored spans by status (matching our EXISTING
  `dec-status-*` palette: pending=amber, verified=green, reversed=red,
  mined=gray, answered=cyan), equal-width spacing (not proportional time —
  avoids the zoom math for this pass), hover tooltip (native `title`,
  simpler than dsh's custom Tooltip component), click-to-jump (expands +
  smooth-scrolls + flash-highlights the matching row in the list below —
  bridges into the EXISTING detail view rather than duplicating it).
  Explicitly deferred to a follow-up: drag-select range, wheel-zoom,
  edge-pan, earlier-history pagination.
  Files: `web/public/index.html` (new `.dec-strip-wrap` container),
  `web/public/styles.css` (new `.dec-strip-*` rules, provenance comment),
  `web/public/app-decisions.js` (`_renderDecisionsStrip`, `_jumpToDecision`,
  wired into `renderDecisions()`).
  **Verified via REAL Playwright** (mandatory per gate (c), this touches
  .js/.css/.html): navigated to this actual session (86 real decisions),
  confirmed 0 new console errors (1 pre-existing unrelated `/api/previews`
  404), screenshotted the strip rendering all 86 spans color-coded, clicked
  a span programmatically and confirmed via DOM query + screenshot that it
  expanded and scrolled the correct decision into view. Both screenshots
  pinned in David's drawer.
  **How dsh actually got running** (worth recording — David was right to
  push back on giving up): prior 2 attempts used `npx` and OOM'd both times
  (silently, no diagnostic output — consistent with a hard SIGKILL). Root
  cause turned out to be TWO separate issues: (1) genuine memory pressure —
  the shared orchestratorHero chromium has 15+ renderer processes eating
  ~8GB (a live/possibly-in-use browser, deliberately NOT touched — separate
  concern, worth flagging to David some day), and (2) my OWN mistake —
  launched the build/install without `setsid`+`nohup`+`disown`, so it also
  died on session-boundary teardown, independent of memory. Fix: switched
  from `npx` (fresh resolution every time) to `git clone` + local `pnpm`
  install (far more memory-efficient — install succeeded in 17s vs OOM),
  AND properly detached the long-running build/serve commands. Cleaned up
  after: killed the dsh web server, closed its tab — it served its research
  purpose, no reason to leave it consuming resources.
- **2026-08-23** — **Decisions timeline strip — FULL interaction parity.**
  David: *"How is it that you decide the surface area is too big? It's not
  too big. You did this in an afternoon, I'm telling you you got days. Go
  ahead the complete surface area."* Correction taken — built everything I'd
  deferred: real proportional-time span positioning (was equal-width),
  drag-to-select a time range with spotlight dimming (outside-range areas
  darkened via the same box-shadow trick dsh uses) that FILTERS the vertical
  list to the selected window with a "N of M shown — Clear" banner,
  wheel-zoom anchored at the cursor (exponential, clamped to a sane minimum
  viewport duration), edge-pan while dragging near the track edges,
  right-click-drag to pan, double-click to reset zoom+range, Escape to clear
  an active range, and a lazy-loaded "earlier history" boundary button. Added
  real server-side pagination to BOTH decision routes
  (`web/src/routes/decisions.js`) — `limit`/`before` params, `hasMore` in the
  response — since neither existed before (routes returned every decision
  unconditionally).
  **Verified via REAL Playwright interaction** (not just DOM inspection —
  actual `page.mouse` drag/wheel/dblclick sequences via
  `browser_run_code_unsafe`, since gate (c) requires genuine browser
  verification and this is exactly the class of bug that curl/eyeballing
  misses):
  - Drag-select: real mouse drag → `49 of 86 shown` banner, spotlight visible,
    37 rows correctly hidden (49+37=86, exact).
  - Wheel-zoom: real wheel event at track center → domain transform scaled
    11x (`--dsw` 100%→1102%), anchor-pan confirmed via `--dsl` shift.
  - Double-click: real dblclick → reset to `--dsw:100%, --dsl:0%`.
  - Escape: real keypress → banner removed, all rows shown again (also
    surfaced a harmless SEPARATE global Escape handler that closes the whole
    drawer — not a regression, pre-existing app behavior).
  - Click-to-jump: real click on a span → row expanded + flash-highlighted.
    First attempt appeared to fail; root-caused via a monkey-patch debug log
    (functions ARE reachable from Playwright evaluate(); top-level `let`
    module state is NOT — a real Playwright/classic-script interaction quirk
    worth remembering) — turned out to be a test-harness artifact (spans
    shifted between query and click because the autoloop was actively
    re-rendering the drawer in the background), not a real bug. Confirmed
    working once isolated.
  - Earlier-history: forced `hasMore:true` via a temporary `fetch` monkey-patch
    to make the button appear, clicked it for real, confirmed the loading
    state, the REAL `before=`-cursor request, and correct settle (button
    hides again once the real response reports no more data — proves the
    round trip, not just the button's existence).
  - Server pagination verified independently via curl: page1 (limit=5) →
    [1225..1229], page2 (`before=`oldest of page1) → [1220..1224], zero
    ID overlap between pages, `hasMore` correct on both.
  Also hit and fixed a **process discipline gap of my own**: forgot to
  restart after editing `web/src/routes/decisions.js` (backend route change,
  needs restart per project CLAUDE.md) while focused on the frontend —
  caught it because `hasMore` was missing from a curl response instead of
  assuming the code was fine.
  Files: `web/src/routes/decisions.js` (pagination), `web/public/app-decisions.js`
  (full engine: `_deriveStripModel`, `_updateStripTransform`,
  `_stripWireTrackOnce`, `_stripApplyRangeFilter`, `_stripLoadEarlier`, and
  the geometry helpers ported from `TrajectoryTimeline.tsx`), `web/public/styles.css`
  (domain-transform + selection/hover-line/earlier-button styles).
- **2026-08-23** — **Self-caught false positive in the #9 parser, same
  session.** Right after writing the #6 entry above, checked the parser's
  OWN output on it (per "don't assume — verify") and found #6 showed
  "shipped" — wrong, the work was real but incomplete. Root cause: the #6
  entry's bold span mentions BOTH "#6" and "#3 ... marked shipped" in the
  same `**...**` run (describing a bug found in #3, not shipping #6) — the
  shipped-detection regex's 100-char window didn't care which slot the
  claim was actually about. Fixed properly, not patched: added
  `_boldSpans()` + `_spanClaims()` helpers requiring a bold span to mention
  ONLY the target slot's number (no other `#N`) before counting a
  shipped/decided claim — eliminates this false-positive class entirely,
  not just this one instance. Verified: direct node run against the real
  file (all 10 slots checked, #6 now todo, other 9 unchanged), live curl
  after restart, AND a real Playwright pass on plan.html (screenshot shows
  #6 correctly blue TODO, 0 console errors) since gate (c) now covers .html.
- **2026-08-23** — **Slot #7 (foreign-harness interop) decided**: B
  (learn-and-adopt), not A (compat layer). Real research (WebFetch on
  deepseek-harness + its actual dependency Cordis, both pre-1.0/unstable, no
  documented plugin contract) + 2 failed hands-on install attempts (OOM
  both times, retried with 4GB heap, still died) made A concretely a bad bet,
  not just lower-priority. One idea worth stealing into slot #6: dsh treats
  the agent loop itself as a swappable plugin, more radical than our current
  Workflow-composes-fan-out design. Added a "decided" state to the parser +
  plan.html (parser only knew shipped/in-progress/deferred/todo — a
  research-only slot resolving via decision, not code, would have wrongly
  shown "todo" otherwise). Also broadened gate (c)'s file regex to include
  .html — it only matched .js/.css, missing plan.html itself, which I was
  about to edit.
- **2026-08-23** — **Slot #9 parser bug fixed + Playwright-verified**. State-
  inference regex only matched `**#N shipped**` literally; missed the
  `**Slot #N (...) shipped**` phrasing used in later entries, so #4/#9/#10
  silently showed "todo" on the dashboard despite being shipped. Fixed with a
  bold-span-scoped regex (`\*\*...#N...shipped...\*\*`, tolerant of "Slot "
  prefix + parenthetical). Verified 3 ways: direct node execution against the
  real file, live curl against `/api/harness-plan`, AND a real Playwright
  pass (desktop full-page + iPhone 14 mobile viewport, 0 console errors,
  screenshots pinned). This is the first slot verified per the new
  Observability & Browser-Verification Methodology (see section above) —
  closes the open question logged for it.
- **2026-08-23** — **Slot #5 (orchestrate skill body) shipped**. Added Part 1
  (classify request as question/small-task/big-task → taxonomy → dispatch via
  Workflow) to `.claude/skills/orchestrate/SKILL.md`, which previously only
  had Part 2 (await-in-turn discipline from slot #2). Fixed heading nesting.
  Verified read-only (skill listing reload confirmed via system-reminder).
  Open question: the classify→dispatch path is written but never exercised
  on a real big-task request — next verification should be behavioral, not
  just structural.
- **2026-08-23** — **Slot #10 (planner-executor split) shipped in orchestratorHero**
  — discovered during autoloop research. Not a llmTerminal build — it's a
  queue-supervisor thing. Role config: planner=fable-5 (read-only look-ahead,
  off by default), doer=sonnet-5 (executor), fallback=opus-4-7, verifier=fable-5.
  Live at `orchestratorHero/scripts/queue_supervisor.py` + config at
  `storage/supervisor/models.json` (no-restart, no-root). Per-item override
  via `exec-limits: model=` timeline stamp. Verified: `test_supervisor_loop.py`
  passes 11 tests. DeepSeek executor lane NOT wired — David-gated (needs API
  budget + trust decision). See `orchestratorHero/development/model_routing_20260823.md`.
- **2026-08-23** — **Slot #4 (frustration classifier) shipped** IN-turn by the
  autoloop. Added `scoreSessionFrustration(session)` to
  `web/src/experiments.js` — fire-and-forget Haiku call at session_end that
  writes a `session_score` row with `{frustration: neutral|frustrated|positive,
  stuck: bool, signals: ...}`. Summarize() now shows a per-variant frustration
  rate + stuck rate + positive rate. Non-blocking (session_end row is the
  authoritative record; score row is a joinable annotation). Judges the
  USER's signal (the outcome variable), not the agent's — matches proper A/B
  variable-manipulation.
- **2026-08-23** — **Slot #2 loop-check VALIDATED** end-to-end. Two test artifacts
  (also autoloop-shipped): `web/scripts/test-loop-check.js` (offline unit test
  with mocked paths) + `web/scripts/drive-loop-check-e2e.js` (live production
  driver). Test result: case 1 (spawn + yield) → wake armed at ~90s with
  correct resume prompt; case 2 (spawn + awaited) → no wake armed. Plus:
  loop-check fired on ME in the wild during the autoloop iteration, correctly
  detecting my "Iteration in flight + ScheduleWakeup" pattern as abandonment
  and auto-resuming with "check status, integrate, don't yield again."
- **2026-08-23** — **Slot #9 (dashboard) shipped** by autoloop workflow before
  it orphaned. Files: new `web/public/plan.html` (342 ln) + new
  `web/src/harness-plan-parser.js` (140 ln) + routes `/api/harness-plan` and
  `/api/activity` added to `web/server.js`. Live at `/plan.html`. Autoloop
  workflows die when the parent session ends, but the file writes from agents
  that already ran DO persist — so partial progress is real.
- **2026-08-23** — **Slot #3 (A/B framework) shipped** by autoloop workflow
  (also survived-partial). Files: new `web/src/experiments.js` (234 ln) with
  `assignVariants`, `recordTurn`, `recordSessionEnd`, `summarize`;
  `web/src/store.js` `_persistSessionIfNew` calls `assignVariants` on
  first-prompt promotion; `/api/experiments/summary` route in `web/server.js`.
  Restart 15:22 UTC to activate. Progress log entry corrected — no live
  experiments configured yet (config file TBD in follow-up); infra is in
  place.
- **2026-08-23** — **DeepSeek provider shipped** (uncommitted, LIVE). Not the
  full cap-hit fallback (#8) — that stays deferred until we build the router.
  Just: DeepSeek is now a first-class provider that appears in the model
  picker. Files: new `web/src/providers/deepseek.js` (structural clone of
  openai.js chat/completions branch — DeepSeek is OpenAI-compat); wired into
  `providers/context.js` (PROVIDER_MAP + getProvider regex), `models.js`
  (DEEPSEEK_TOP + fetchProviderModels branch), `pricing.js` (DEEPSEEK_MTOK
  table, rates null pending David's account confirmation), `server.js` (import
  + `_runFn` router). Verified via `/api/models` (returns 5 deepseek models)
  and `getProvider("deepseek-v4-flash")` → "deepseek". **Requires `DEEPSEEK_API_KEY`
  in `~/.llm-terminal/env` for actual API calls** — picker shows the models
  either way. Model IDs from Aug 2026: `deepseek-v4-pro`, `deepseek-v4-flash`,
  `deepseek-v4-flash-vision-exp`; legacy names kept for graceful downgrade.
- **2026-08-23** — **Native autoloop recurrence: fixed the silent-death bug**
  David caught live ("I see it working and also the timer is running at the
  same time"). Root cause: `runStarted()` (`web/src/run-registry.js`)
  unconditionally disarmed ANY pending wake on every new turn — a rule that
  predates `autoloopIntervalMs` and correctly kills a ScheduleWakeup-set wake
  the model didn't re-arm, but also killed the autoloop's OWN standing wake
  the instant David sent a plain chat message, while the topbar setting
  stayed "on" (dead timer, live-looking button). Fix: extracted shared
  constants/prompt into new `web/src/autoloop.js`; `runStarted()` now takes
  an optional `{autoloopIntervalMs, autoloopPrompt}` and re-arms fresh from
  THIS turn's start instead of disarming when the session has autoloop on;
  removed the now-redundant re-arm block from `sweepDueWakes()` (server.js)
  so there's exactly one re-arm path. **Verified via curl** (`GET
  /api/sessions/:id/wake`) — confirmed `armed:true` survives a manual chat
  turn post-restart; syntax-checked all 4 touched files before restart.
- **2026-08-23** — **Topbar cleanup, two more David-caught bugs.** (1) "one
  minute loop to the left flickering green, to the right also flickering
  green... mix those two" — the far-right dot was `.dot-status` (`#ds`), a
  pre-existing WS-connection indicator, unrelated to autoloop but visually
  identical (green pulsing dot) and positioned at the opposite end of the
  topbar from the new autoloop button. Merged: removed `#ds` entirely,
  `setStatus()` now just records WS state and `_renderAutoloopBtn()`
  (`app-status.js`) is the single render path — connection trouble
  (`ws-thinking`/`ws-error` classes, yellow/red) always overrides the loop
  label since a dead WS matters more than a countdown. (2) "when it says one
  queued it completely ruins the whole layout" — `#queueCount` was appended
  as a raw `.topbar` flex child, invisible to `app-topbar.js`'s collapse
  budget (`recalc()` only measures `.topbar-nav`'s direct children AND its
  MutationObserver only watches `nav`), so the moment it grew real width the
  row overflowed with nothing shrinking to compensate. Fixed via
  `position:absolute` (out of flow entirely) — this landed mid-session from
  a concurrent autoloop iteration while a later turn was investigating the
  same report; verified by simulating a 2-item queue in the live page and
  screenshotting (topbar held, no overflow). **Verified via Playwright**:
  navigated the live mobile viewport (390×844), confirmed `#autoloopBtn`
  classes toggle correctly for active/`ws-thinking` states, screenshotted
  before/after.
- **2026-08-23** — **Wake-countdown bar: fixed "firing now" while still
  working.** David: "it says auto-resume firing now but it's still working."
  Consequence of the autoloop re-arm fix above: `runStarted()` re-arms the
  NEXT wake the instant a turn STARTS, so `/api/sessions/:id/wake` reports
  the next wake as due/overdue for the entire duration of any turn that
  outlasts the loop interval (e.g. a 9-minute turn on a 1-minute loop) — the
  countdown bar then showed "Auto-resume firing now…" nonstop even though
  nothing could actually fire (`sweepDueWakes` skips sessions with a live
  proc). Fixed in `_renderWakeCountdown()` (`app-status.js`): hides the bar
  outright whenever the existing `busy` flag (set by `setBusy()`, already
  driving the Stop button) is true — a busy run makes the countdown moot
  regardless of what the server reports. **Verified via Playwright**:
  reloaded the live page mid-run, confirmed `busy===true` and the countdown
  bar absent from the screenshot while "⏳ working" + Stop button were shown.
- **2026-08-23** — **orchestrate-tournament eval harness: built, NOT yet
  execution-verified (real external blocker).** Closes half of the open
  question "claude plugin eval harness ... infra exists (case.yaml +
  graders), never actually written." New
  `plugins/orchestrate-tournament/evals/` with three real cases
  (`prompt.md` + `graders/criteria.md` each, matching the documented format
  from `claude plugin eval --help`): `simple-question` (false-positive check
  — a pure question, both arms should skip Workflow), `multi-independent-task`
  (unambiguous big-task — four unrelated production incidents, both arms'
  own SKILL.md agree this should decompose or at least get a complete
  direct answer, no ping-me-status), `borderline-batch-question` (the actual
  adversarial fork probe — three tiny inline config files, deliberately
  matching `orchestrate-minimal`'s own stated non-example almost verbatim,
  designed to make the two arms diverge). Grading criteria are grounded in
  each variant's own SKILL.md language, not invented from scratch.
  **Could not execute a live run**: `claude plugin eval init --bare` and
  presumably `claude plugin eval` itself return `` `plugin eval` is
  currently in early access `` on this account — confirmed via the actual
  CLI error, not assumed. This is an account-level GrowthBook-style feature
  gate, not a `~/.claude/` file permission issue, so there's no local
  workaround; `claude plugin validate` on the plugin still passes. Genuinely
  blocked pending early access — flagged, not silently skipped.
  **Still open**: (1) the vendor-harness-sandbox reusable script/skill
  (dsh clone→install→run pattern done twice manually, never turned into a
  callable tool) — untouched this iteration; (2) actually running this eval
  suite once early access is available.
- **2026-08-23** — **vendor-harness-sandbox: built + fully verified.** Closes
  the other half of the open question ("dsh clone→install→run pattern done
  twice manually, never turned into a callable tool"). New
  `web/scripts/vendor-harness-sandbox.sh` (`start|status|logs|stop|clean`)
  generalizes the exact lessons from the dsh incident (HARNESS_PLAN's "How
  dsh actually got running" entry): `git clone` instead of `npx` (memory-
  cheap, avoids the OOM trigger), `setsid nohup ... < /dev/null & disown`
  for the serve command (survives session-boundary teardown independent of
  memory pressure), state tracked in `~/.llm-terminal/vendor-sandboxes.json`
  (pid/port/workdir/log path per sandbox, keyed by caller-chosen name),
  clones live under `~/.llm-terminal/vendor-sandboxes/<name>/`. Paired with
  new project skill `.claude/skills/vendor-harness-sandbox/SKILL.md`
  (usage + when-to-use + the two failure modes spelled out so they don't
  get rediscovered by hand again).
  **Verified via `unit-test`-style live smoke test** (not just read-through):
  built a real tiny local git repo (`/tmp/fake-vendor-repo`, a `package.json`
  + trivial `http` server) and ran the full lifecycle against it —
  `start` → cloned, `npm install` completed, detached process spawned;
  `status` → reported RUNNING with correct pid/port; `logs` → showed the
  real npm/node stdout; `curl localhost:4999/` → got the real HTTP response
  from the spawned server; **confirmed true session-detachment** via `ps -o
  pid,ppid,pgid,sid` on the spawned pid — `ppid=1` (reparented to init),
  `sid=pgid=`its own pid (own session/process group), proving it would
  survive this shell/session ending, which is the exact failure this tool
  exists to prevent; `stop` → process gone, port connection refused; `clean`
  → workdir removed, state file entry gone. All five subcommands exercised
  against real state, not mocked. Temp repo + state cleaned up after.

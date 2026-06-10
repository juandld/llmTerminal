# camofiles / llmTerminal — Architecture & North Star

> The single source of truth for *why this code exists* and the laws it obeys.
> Read this before any non-trivial change. Every module boundary and data model
> should be justifiable against §1. If a change doesn't serve the north star or
> violates a §3 principle, it's wrong even if it works.
>
> Status: §1–§4, §6 are settled (David's direct vision + the code). §5, §7, §8
> marked **[DRAFT — confirm]** are my best reconstruction; David red-pens them.

---

## §1 — North Star

**camofiles** is David's brand and agency. Its thesis is the **human–machine
interface** — how we merge the concept of *self* with the computer. David's role
is **abstraction architect**: most white-collar work is, at bottom, *organizing
abstractions*, and camofiles is the practice of doing that at the boundary
between mind and machine — for himself, for clients, and for the app ideas that
fall out of it.

This system is the **instrument** of that practice, and it has one job:
**weaponize ADHD** — collapse the distance between *having* an idea (an
abstraction) and *acting* on it to near-zero. Grab the phone, speak the idea, and
the machine carries the follow-through that attention won't sustain. Ideas are
worth running even when they might fail, because trying is how you learn.

It is also a **self-improving forge**: doing real work is what improves the
ecosystem, because friction is intolerable and noticing it is automatic — so the
interface grows more seamless every time it's used.

**Optimizes for:** time-from-idea-to-action · throughput of cheap experiments ·
seamlessness of the human↔machine merge.
**Cardinal sins:** friction at the point of capture, and friction in improving
the system itself.

---

## §2 — Operator & Scope

- **Today:** a single operator (David), mobile-first. Ideas strike anywhere; the
  phone is the cockpit.
- **Soon:** a small team (operators/VAs) who also direct agents. So identity and
  visibility **must not be hardcoded to one person** — the david-only boundary is
  a current implementation, not a permanent assumption. Design for "an operator,"
  not "David."
- **Not** a multi-tenant SaaS product. Optimize for a trusted handful, not the
  open internet.

---

## §3 — Core Principles (the laws the code obeys)

1. **Capture latency → 0.** Idea-to-launch is measured in seconds. Mobile-first,
   voice input, one always-ready input box, no setup. *Why:* the north star.
2. **The system carries follow-through, not the operator.** Agents run headless
   and keep going. *Why:* ADHD is strong on ideation, weak on sustained execution.
3. **Context-switching is the default.** The operator jumps between ideas
   constantly. Many concurrent project sessions; the chat is **sacred** —
   resumable, never dropped (outbox, heartbeat, reconnect, 60s graceful shutdown).
4. **Nothing gets dropped.** Attention counter, decisions framework, priority
   "what's next" scoring surface what needs the human back. *Why:* ADHD loses
   threads.
5. **Cheap to try anything.** Spinning up a hero/agent/experiment is easy;
   failure is data. *Why:* the experiment-throughput north star.
6. **Declarative single source → generated artifacts.** `projects.json` is the
   spine; `sync-config.py` regenerates systemd / nginx / `.claude.json` / noVNC /
   server.js port tables. Config is *derived*, never hand-edited in N places.
7. **Provider-agnostic, one bridge.** Claude/OpenAI/Gemini behind a uniform
   runner; `web/src/mcp/` makes Claude's MCP tools work on the others. One tool
   model, three backends.
8. **Human-in-the-loop is first-class.** Decisions, attention, drafts-over-sends,
   permission cards. The UI's job is to keep the operator in command.
9. **The ecosystem is its own forge — facility is the metric.** Real tasks drive
   improvement; "more seamless" is the bar. Therefore **self-modification must be
   cheap: small single-purpose modules, single sources of truth, no monoliths.**
   An abstraction architect's tools must themselves be clean abstractions. This is
   why modularity here is law, not style.
10. **The data primitives ARE the product.** `session`, `project`, `decision`,
    `task`, `attention item`, `draft` are the abstractions being organized. Keep
    them first-class, single-sourced, composable. The UI just renders them.

---

## §4 — The Agent & Orchestration Model

The hard problem: *many agents at once, mixing their work, without me managing
them like humans.* Solution: flatten an org to its irreducible roles and make
coordination **deterministic** instead of social.

### The layers (shallow by design)
- **MCP = capabilities** (the hands): atomic verbs — click, send, query, draft.
  Shared, stateless pool. (`web/src/mcp/`, the `.claude/mcp-servers/`.)
- **Skill = procedure** (the playbook): how to do a recurring task *well*, written
  once, versioned. Composes MCP verbs + knowledge. (Claude Code skills /
  `.claude/commands/`.)
- **Agent = a worker** (the employee): a goal-pursuing loop with skills+tools, in
  an **isolated workspace**, spawned per task, disposable.
- **Orchestrator = the manager** (orchestratorHero): decomposes a goal → spawns
  isolated workers → merges outputs. The *only* layer above agents.

**Shallow = one manager, a flat fan of workers, a flat skill catalog, a flat tool
pool. Wide, never deep — map-reduce, never agent→agent→agent.** Nesting recreates
middle-management and destroys legibility.

### Built vs missing — supervisor ≠ orchestrator  *(the keystone gap)*
- **Built (the downward axis):** a **supervisor on every working agent** —
  `spawnObserver` / `spawnDecisionExtractor` / `spawnContractCheck` watch each run,
  mine its decisions, and verify it actually finished. This is per-worker
  oversight (quality · decisions · done-ness) feeding the attention/decisions
  framework. Valuable — but it's *supervision*, not *orchestration*.
- **Missing (the keystone):** the real **orchestrator** — the manager *above* all
  workers. orchestratorHero is the intended home, but the coordinating logic isn't
  built. The parallel-agent collision of 2026-06-10 is the symptom: with no
  orchestrator to isolate and sequence concurrent agents, they stepped on each
  other.

The orchestrator must:
1. **Intake** a goal from the cockpit.
2. **Decompose** it into sub-tasks (which heroes/skills + dependencies).
3. **Dispatch + isolate** — spawn each worker in its own workspace
   (worktree/branch/context). Isolation by construction → no collisions.
4. **Coordinate** — track status (via the supervisors), resolve handoffs/deps.
5. **Merge** — divide-and-merge or fork-and-select (below).
6. **Report up** — surface results + what needs the operator, into attention/decisions.

So the whole hierarchy is **two flat levels**: supervisors report *up* to the
orchestrator; the orchestrator reports *up* to the cockpit. That's it.

**This is the next keystone build — and it's *why the refactor comes first*.** A
clean, modular codebase is what makes a good orchestrator cheap and safe to build
(§3.9, the forge). You cannot build a sound manager on top of a monolith.

### Emulate from human orgs
Specialization · a manager who assigns *and integrates* · isolated workspaces ·
structured handoffs (artifacts, not chatter) · one source of truth · status/standup.

### Beat the human standard (the unique edge)
- **Instant, disposable, forkable workers** — run 10 variations of an idea, keep
  the best, kill the rest. Humans can't be forked.
- **Deterministic coordination** — isolation/locks/merge enforced in code
  (worktrees, git, SSOT), not social coordination. (The parallel-session collision
  observed 2026-06-10 *is* the human failure mode; worktree-per-agent is the fix.)
- **Perfect observability + replay**, zero ego, zero management overhead.

### Delegation, reframed (for an operator who dislikes managing people)
You're not bad at delegating — you dislike the *human overhead* (feelings,
ambiguity, nagging). Agents delete it. Delegation becomes **specification** (write
the skill once) + **orchestration** (deterministic fan-out/merge). Define the org
once; then throw ideas at it. The system manages the agents; you architect.

### Mixing work — two modes, one orchestrator
1. **Divide-and-merge** (map-reduce): split a goal → parallel isolated agents →
   merge structured outputs.
2. **Fork-and-select** (tournament): N agents attempt the same task differently →
   judge → keep/blend the best. (This is the cheap-experiments north star, applied
   to execution.)

---

## §5 — The Portfolio  **[DRAFT — confirm]**

Each hero is a per-project agent context (own browser/CDP/display/profile/color,
registered in `projects.json`).

- **camoHero** — camofiles.app operations (vacation rentals); the **only
  email-sender** (hostchat/Resend); bookings via Smoobu/HomeToGo/vikey.
- **crankHero** — CrankWheel sales/ops; **drafts-only**; commission truth =
  `data.somatic` live API (not the sheet); meeting.is admin.
- **orchestratorHero / narrativeHero** — the dashboard + library backend
  (hero.camofiles.app, library.camofiles.app); content/narrative generation;
  task-board/queue; the **orchestrator** role from §4.
- **langHero** — *[confirm: language-learning content? story player on :5200]*
- **dataHero** — research/data (SerpAPI, Google Workspace, flights).
- **osHero** — host-level daemon/automation + Telegram alerts.
- **mediaHero** — *[confirm: video/media production?]*
- *[confirm: which are dead, which are missing, and each one's real
  business mapping]*

---

## §6 — Architecture & Sources of Truth

- **llmTerminal = the cockpit** (the command surface), not the orchestrator. The
  `Terminal` tab of hero.camofiles.app; the rest of that app is orchestratorHero.
- **Backend** `web/server.js` (4167 -> ~1233 ln) = bootstrap + HTTP routes. The
  rest is `web/src/`: `paths`/`store`/`models`/`permissions`/`proc-state` (SSOTs+state),
  `providers/{context,claude,openai,google}` (the worker runners),
  `supervisors` (the §4 per-agent watchers), `ws/{broadcast,connection}` (the core
  message loop), `cheap-model`, `session-title`, `bwrap` (sandbox leaf), `tools`,
  `attribution`, `voice-nonce`, `queue`, `uploads`, `gmail`, `priority`, `auth`,
  `routes/*`, `mcp/*`. ~27 modules; the whole run-loop is modular + e2e-validated.
  *Remaining: the 30 HTTP routes still inline in server.js — clean follow-up.*
- **Frontend** `web/public/app.js` → decomposed into `app-*.js` classic scripts
  sharing global scope (cache-busted; **not** ES modules — internal imports would
  break the mobile cache-bust).
- **The canonical SSOTs:**
  - `web/config/projects.json` — every per-project fact (ports/paths/policy).
  - `web/src/store.js` — sessions + messages.
  - `web/src/models.js` — model catalog (client fetches `/api/models`).
  - `web/src/paths.js` — filesystem paths.
  - **THIS doc** — the why + the laws.

---

## §7 — Per-Project Policy  **[DRAFT — confirm]**

Per §4, autonomy is per-hero, so policy must be **declarative** — proposed as a
`policy` block in each `projects.json` entry, not hardcoded in logic:

```jsonc
"policy": {
  "can_send_email": false,        // crankHero: false (drafts-only); camoHero: true
  "can_spend_money": false,
  "outward_actions": "draft",     // "draft" | "approve" | "auto"
  "test_recipients_only": true    // never real client emails in test paths
}
```
*[confirm: the real dimensions + each hero's settings]*

---

## §8 — Non-Negotiables  **[DRAFT — confirm]**

- **The chat is sacred** — never `kill -9` llm-terminal; use `systemctl restart`
  (graceful 60s). Dropping the operator's session is the worst outcome.
- **crankHero never sends.** **camoHero is the only sender.** Never test send
  paths with client emails — use david@camofiles.app / david@crankwheel.com.
- **Commission authority = `data.somatic` live API**, not the Google sheet.
- **The hero-restart-helper allowlist is the security boundary** — don't widen it
  casually.
- **Secrets stay 600 / off command lines / out of transcripts.**
- hero.camofiles.app is operator-only today (must generalize for the team).
- *[confirm: what else is a "never break this" law]*

---

## §9 — Glossary

- **hero** — a per-project agent context (camoHero, crankHero, …).
- **session** — one chat thread, project-scoped, resumable; the central entity.
- **decision** — a recorded fork the agent (or operator) took; the decisions
  framework visualizes the tree.
- **attention item** — something surfaced as needing the operator back.
- **cockpit** — llmTerminal: where the operator commands everything.
- **orchestrator** — orchestratorHero: decomposes goals, fans out agents, merges.
- **the forge** — the self-improving loop: doing work → noticing friction →
  improving the ecosystem.

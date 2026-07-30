# Commit-before-done gate — where to put it, and how (2026-07-22)

_Verification-gap #3 from `orchestratorHero/development/handoff_verification_gap_fix_20260722.md` §3.4 ("Commit-before-done discipline")._

## Conclusion (up front)

**Put the gate in llmTerminal's `spawnContractCheck` supervisor** (`web/src/supervisors.js:335`). Extend the existing done-arbiter with a git-porcelain check keyed off `session.project`, and — when the agent's closing message uses shipped/fixed/live/pushed language — either **append an `⚠ UNCOMMITTED — will be lost on checkout` banner** (the tab-etiquette pattern at supervisors.js:389-406) or refuse to set `manualDone`.

Do **not** put it in an orchestratorHero invariant / queue-supervisor post-run hook. Reasons in §3.

## 1. What the incident actually was

From `orchestratorHero/development/handoff_verification_gap_fix_20260722.md:25`:

> **Durability gap.** All of it was working-tree only. Uncommitted work can't be lost-detected, diffed, or reviewed, and it silently reverts on any checkout. There was no artifact anyone could audit against the claims.

And L5:

> `HOOK_WRITER_MODEL=gpt-5.5` silently overrode the pipeline's own DeepSeek default in the production call path, so every real hook was still written by gpt-5.5 (corporate mush) for 8+ days, while the agent had verified only the isolated component… **None of it was committed.**

The session was **llmTerminal session `93007829-3875-4b64-969f-48d4ffc2cd17`** (L8). An interactive chat, not a queue-supervisor task. That is the relevant sample for choosing the gate's home.

## 2. Why `spawnContractCheck` is the right home

### 2a. Session-scope git state is *trivially* observable there

`spawnContractCheck(sessionId, projectName)` is called with the project name — see `web/src/providers/claude.js:199` and `web/src/ws/connection.js:440`. The session record confirms `project` is always present:

```
$ python3 -c "import json; d=json.load(open('/home/claude-user/.llm-terminal/sessions.json')); print(sorted(d[0].keys()))"
['awaitingResponse', 'claudeSessionId', 'created', 'effort', 'id',
 'lastActive', 'lastMessageRole', 'lastSnippet', 'lastViewed', 'manualDone',
 'messageCount', 'pendingAsks', 'project', 'provider', 'title',
 'titleGenerated', 'titleUserMsgs']
```

Combined with `PROJECTS_DIR = "/home/claude-user/projects"` (`web/src/paths.js:6`), the git cwd is one join away:

```js
const projectRoot = path.join(PROJECTS_DIR, session.project);
const { execSync } = require("child_process");
const dirty = execSync("git status --porcelain",
  { cwd: projectRoot, encoding: "utf8" }).trim();
```

On this repo right now that yields exactly the state `git status` shows in the harness banner (verified live):

```
$ git status --porcelain | head -3
 M web/public/app-input.js
 M web/public/app-session-cost.js
 M web/public/app-sidebar.js
```

### 2b. The precedent is already in the same function

`web/src/supervisors.js:389-406` — the browser-tab-etiquette check — is *exactly* the shape we want:

```js
// supervisors.js:396-405
if (navigated && !madeOwnTab && !alreadyWarned) {
  saveMessage(sessionId, {
    role: "assistant",
    text: "⚠ Browser etiquette: this run navigated the shared chromium…",
    ts: Date.now(),
    source: "contract_check_tab_etiquette",
  });
  try { broadcastToSession(sessionId, { type: "history", messages: loadMessages(sessionId) }); } catch {}
  console.log("[contract-check]", sessionId.slice(0, 8), "→ tab-etiquette warning…");
}
```

Same tick, same session, same `saveMessage(source: "contract_check_*")` + `broadcastToSession` re-render idiom. A `contract_check_uncommitted` warning parallels it one-to-one. The `alreadyWarned` re-check guarantees idempotence — no duplicate banners on repeat ticks.

### 2c. The done-arbiter already fires at the exact moment we need

Read `supervisors.js:494-507`:

```js
if (parsed.done === true) {
  if (s2.manualDone) { … return; }
  const summary = String(parsed.summary || "").trim().slice(0, 240);
  s2.manualDone = Date.now();
  saveSessions(sessions2);
  if (summary && !lastText.includes(summary.slice(0, 30))) {
    try { saveMessage(sessionId, { role: "assistant", text: "✓ " + summary, ts: Date.now(), source: "contract_check" }); }
    catch (e) { console.warn("[contract-check] append failed:", e.message); }
  }
```

This is the *sole automated source of truth for "task complete"* — the comment at supervisors.js:317-329 says so explicitly. Gating this branch on git-porcelain-clean-when-claim-is-shipped is the enforcement layer §3.5 of the handoff asks for ("polite layer already failed — build the enforcement layer").

### 2d. Only-this-session's-files false-positive guard is already available

The concern: David has 9 other unrelated dirty files in this repo right now (see §2a). We do **not** want every "done" to flare uncommitted just because *another* session left junk.

`web/src/attribution.js` + `~/.llm-terminal/file_attribution.jsonl` already record per-session file touches:

```
$ tail -1 ~/.llm-terminal/file_attribution.jsonl
{"path":"/home/claude-user/projects/crankHero/campaigns/APPROVALS_PAGE_DESIGN_BRIEF.md",
 "session_id":"12ebe07c-713a-46f1-bbb4-b003ca0ab21d","tool":"show_file","ts":1784761866985}
```

The gate intersects `git status --porcelain` output with paths whose `session_id === sessionId` in `file_attribution.jsonl`. Only files *this session* actually wrote/edited AND are still uncommitted trigger the warning. Zero engineering to reuse — the attribution log is already durable across restarts (`supervisors.js:244 reconcileFileAttribution` also feeds it post-run).

### 2e. Claim-language detection is a two-line regex

Handoff §3.4: *"Work an agent calls 'shipped/fixed/live' must be committed."* On the `lastText` (already in scope at supervisors.js:413):

```js
const shipClaim = /\b(shipped|deployed|pushed|committed|committed and pushed|live in production|live now|wired into production|in production|applied|flipped|landed)\b/i
  .test(lastText);
```

If `parsed.done === true && shipClaim && dirtyOwn.length > 0` → warn + refuse to auto-set `manualDone` (leave it for user or a real commit to clear). This is the exact policy §3.3's Claims→reality audit prescribes ("UNVERIFIED CLAIM marker and do NOT let the session mark itself done clean").

## 3. Why *not* orchestratorHero invariant / queue-supervisor

Both were on the table (task brief). Neither fits.

### 3a. Invariants have no session context

`orchestratorHero/scripts/invariants/` is a scan-the-repo-at-a-point-in-time lint set. Read `95-config-shadow.py:1-23` — the whole module is AST-walking one file. No session, no project scope beyond ROOT-relative paths, no way to correlate "the agent said shipped" with "the working tree it wrote against." Bolting a session-aware gate onto the invariant runner would recreate the plumbing that `spawnContractCheck` already ships with.

### 3b. Queue-supervisor covers only queue-driven tasks

`orchestratorHero/scripts/queue_supervisor.py:87-101` — the doer-verifier loop already lives in worktrees per task, and the verifier is explicitly told to *"Inspect git status/diff, keep what is correct, and close exactly these gaps"* (`queue_supervisor.py:599, 743, 869-870`). So the queue side has a partial gate already, in the verifier.

But that only fires on queue-driven tasks. **The Jul 8–21 incident was an interactive llmTerminal chat.** The population where the bug bit == interactive sessions. Putting the primary gate on queue-supervisor would leave the population where it actually happened uncovered.

### 3c. Interactive sessions are where "shipped/fixed/live/pushed" claims happen in prose

The queue-supervisor's tasks return structured verdicts (`VERDICT_SCHEMA`, `queue_supervisor.py:103-113`) — `done: bool, evidence: str, missing: str`. Claim/reality slippage there is bounded by the schema.

Interactive assistant text — the thing `spawnContractCheck` reads — is free-form English where "live in production" gets typed with no backing evidence. That is exactly the failure surface handoff §2.2 names ("Claim/reality gap in reporting") and it lives in llmTerminal chat text, not in verifier JSON.

## 4. Concrete extension sketch

**File:** `web/src/supervisors.js`, inside `spawnContractCheck`, between the tab-etiquette block (L389-406) and the "Quick prefilter" (L408). Runs on every tick — cheap, no LLM call, pure disk read.

```js
// ── Commit-before-done gate (verification-gap #3) ──────────────────────
// Handoff §3.4: work an agent calls "shipped/fixed/live/pushed" must be
// committed before the session is marked complete, or explicitly labeled
// UNCOMMITTED. Only files THIS session actually touched (per
// file_attribution.jsonl) are counted, so unrelated dirty files in the
// same project dir don't false-fire. Warn-only + refuse to auto-set
// manualDone when done+claim+dirty is true. Mirrors tab-etiquette
// (supervisors.js:389-406).
try {
  const shipClaim = /\b(shipped|deployed|pushed|committed|live in production|live now|wired into production|in production|applied|flipped|landed)\b/i.test(lastText);
  if (shipClaim) {
    const projectRoot = path.join(PROJECTS_DIR, session.project);
    const dirty = require("child_process")
      .execSync("git status --porcelain", { cwd: projectRoot, encoding: "utf8" })
      .trim().split("\n").filter(Boolean)
      .map(l => path.resolve(projectRoot, l.slice(3)));
    // Intersect with THIS session's attributed files:
    const mine = new Set(loadSessionAttributedPaths(sessionId));  // one-line helper over file_attribution.jsonl
    const dirtyOwn = dirty.filter(p => mine.has(p));
    const alreadyWarned = recent.some(m => m.source === "contract_check_uncommitted");
    if (dirtyOwn.length && !alreadyWarned) {
      saveMessage(sessionId, {
        role: "assistant",
        text: "⚠ UNCOMMITTED — will be lost on checkout. This run claimed shipped/live/pushed but " + dirtyOwn.length + " file(s) it touched are still in the working tree:\n" + dirtyOwn.slice(0, 8).map(p => "  " + p).join("\n") + "\n\nCommit before marking done, or reword the claim.",
        ts: Date.now(),
        source: "contract_check_uncommitted",
      });
      // Refuse to auto-mark done this tick — user or a real commit unblocks.
      try { broadcastToSession(sessionId, { type: "history", messages: loadMessages(sessionId) }); } catch {}
      console.log("[contract-check]", sessionId.slice(0,8), "→ UNCOMMITTED ship-claim (" + dirtyOwn.length + " own dirty file(s))");
      return;   // ← blocks the auto-done judge below from setting manualDone this tick
    }
  }
} catch (e) { console.error("[contract-check] commit gate failed:", e.message); }
```

Notes on the `return`: the gate is intentionally *hard* — the tab-etiquette check is warn-only because a stray browser_navigate is often benign. A shipped-but-uncommitted claim is exactly what §3.4 flags as durability-critical, and matches §3.3's "do NOT let the session mark itself done clean." An explicit `llmt_complete(summary="UNCOMMITTED — will be lost on checkout")` from the agent can still set `doneSource: "mcp"` if the agent wants to override, which preserves escape hatch symmetry with `supervisors.js:509-515`.

## 5. Acceptance replay (handoff §4)

Replayed against the Jul 8–21 state:

- Session 93007829… claims "wired into production", "live", "gpt-5.5 no longer in default path anywhere" (msg #1682/#1685).
- Working tree at that moment: `HOOK_WRITER_MODEL` change to `company_research.py:~L40` — **uncommitted**.
- `git -C /home/claude-user/projects/dataHero status --porcelain` returns `M ingestion/company_research.py`.
- `file_attribution.jsonl` has entries for that file with `session_id: 93007829…` from Edit/Write tool logs.
- Intersection non-empty → **UNCOMMITTED banner fires**, `manualDone` refused, sidebar stays yellow instead of green. David sees it in his sidebar, not eight days later by taste-testing the output.

## 6. What this deliberately does NOT do

- Does not check any other project's git tree — only `session.project`. Cross-repo work in one session (rare but real, see `session.extra_project_dirs` at `supervisors.js:250-254`) is out of scope for v1; add later if needed.
- Does not check `git log origin/main..HEAD` — "committed but not pushed" is a weaker durability failure than "not committed at all," and pushing is a distinct authorization action David hasn't asked us to auto-verify.
- Does not touch the queue-supervisor verifier. That path is doing fine (§3b); duplicating the check there is scope creep.
- Does not modify prose in CLAUDE.md — handoff §5 explicitly forbids "add more prose telling agents to be careful." This is the enforcement layer.

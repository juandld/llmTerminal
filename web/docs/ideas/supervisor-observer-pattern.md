# Supervisor/observer pattern for agents

**Source**: David's voice notes in session 3426e0c7 (May 12-13, 2026).
**Surfaced**: agent recap at 2026-05-13T~07:00 UTC after David asked "is there anything that was left out... lost in the ether?"

## The idea

Workers (agents driving a chat) should **not** be responsible for reporting what
they did at the end of a task. That adds load to the worker and pollutes the
work itself with meta-commentary.

Instead, **a separate observer agent** runs alongside (or right after) the
working agent. The observer:

1. **Reads the worker's output** — tool calls, assistant text, user messages
2. **Figures out what was actually accomplished** vs what was asked for vs what
   was sidelined
3. **Registers entries on the task board** — both completed items (for audit
   trail) and dangling items (so they don't get lost)
4. **Does not interrupt the worker** — fire-and-forget from the worker's PoV

## Why

- Workers can stay focused on solving the user's request — no "tell me what
  you did" tax at the end
- David sends a lot of voice notes mid-task; some get queued, some get
  addressed, some get half-addressed, some get *forgotten* because attention
  moves on. The observer catches the last category.
- It's a QA + project manager rolled in — at the **individual agent** level
  initially, maybe **team level** later (one observer per project, one
  observer per chat session, etc.)

## Implementation sketch

1. **Trigger**: after each `claude -p` run completes (`result` event in
   server.js), spawn a *light* observer run
2. **Model**: Haiku (fast, cheap) — doesn't need Opus
3. **Prompt**: "Here's the last N messages. The user asked for X items. The
   agent addressed Y. Return JSON: `{tasks: [{title, description, status:
   'review'|'done'}]}` for everything mentioned-but-not-clearly-done."
4. **Output**: POST to `/api/tasks` with status `review` so David can confirm
5. **Tasks UI**: already exists (topbar `Tasks` button); review-status tasks
   appear in the NEEDS YOU bucket

## Open questions

- How aggressive? Every run? Every N messages? Only when user explicitly asks?
- Cost: Haiku is cheap (~$0.001 per observation) but it adds latency
- De-duplication: how do we avoid observing the same idea twice across multiple
  runs? Probably hash-by-title or summary similarity.
- **Tasks creation endpoint** doesn't exist yet — llmTerminal only proxies GET
  + transition. Need a POST `/api/tasks` that creates a task in the
  narrativeHero orchestrator. That's prerequisite #1.

## Related

- David's recovered voice note from 2026-05-13 06:04: full transcript saved in
  `narratives/utm-windows-tutorial.md` adjacent — TODO move to a proper voice
  note archive.

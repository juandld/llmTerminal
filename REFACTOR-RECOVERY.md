# llmTerminal — Pre-Refactor Recovery Manifest (2026-06-10)

Everything valuable that was floating in git limbo has been preserved on durable
branches **and** as immortal patches before the planned full refactor. Source of
the feature inventory: terminal session `55299920-0f3c-437a-87e6-46206aca6c01`
("Lost Files Drawer Audio Playback Changes").

## Branches

| Branch | Contains | Origin | Validated |
|---|---|---|---|
| `wip/live-state-2026-06-10` | **The actual running app** — ~3 weeks of edits that were live but never committed: effort selector, in-browser OAuth (`claude-auth.html`), rendering fixes, `server.js` localhost-bind security fix, and `web/src/mcp/*` (which `server.js` requires but was untracked → repo was previously unbuildable). **Use this as the refactor base.** | uncommitted working tree | `node --check` OK |
| `recovery/drawer-playback` | Files-drawer audio playback: multi-select (shift-range), sequential queue, transport controls, now-playing highlight, `/api/drawer-files` (~1200 ln). Session-isolation hardening bundled in. | `git stash@{0}` (2026-05-21) | `node --check` OK |
| `recovery/attention-nav-ui` | "Next attention item" task-board UI: attention banner, task cache, `setChatStatus`, chat-to-chat attention nav (~230 ln). | `git stash@{2}` (2026-05-18) | `node --check` OK |
| `recovery/playwright-pin` | `sync-config.py` Playwright MCP path pin (stops emitting `@playwright/mcp@latest` via npx — a live regression) + langHero project entry. | `git stash@{1}` (2026-05-20) | `node --check` OK |

## Immortal patch backups
`~/llmterminal-recovery-2026-06-10/` — `stash0/1/2-*.patch`, `working-tree-*.patch`,
untracked-files/, `STATE-MANIFEST.txt`. Independent of git; nothing here can be lost.

## Git issues resolved
- Uncommitted live working tree (2,746 ln across 6 files) → committed.
- `web/src/mcp/*` was `require()`d by server.js but untracked → now tracked (repo builds from clean clone).
- `web/src/` was **root-owned** (May 28 root session) → chowned back to claude-user.
- `CLAUDE.md` was untracked → now tracked.
- Screenshots + local `web/llmt.db` → gitignored.
- 3 dangling stashes → promoted to recovery branches (stashes left in `git stash list` as extra insurance; safe to drop once confident).

## Refactor caveats
- **Overlap check:** per the diagnosis, `nextAttentionSession` from the attention-UI work was *partially* re-done in live already — diff `recovery/attention-nav-ui` against live before re-applying, to avoid double-applying.
- Recovery branches are based on their **original 05-1x bases**, not live — expect to cherry-pick/port the feature hunks onto the refactor base rather than straight-merge.
- 6 `refactor/sidekick-2026-05-*` daily dedupe branches still exist (pushed); they are the "stash-and-forget" culprit. Root cause: the dedupe pass ran on a dirty tree and stashed WIP without popping. Fix going forward: refuse to run on a dirty tree (or commit WIP to a branch instead of stashing).

## Not yet pushed
All of the above is local (on the VPS) + patches. Push to `origin` (GitHub) pending your go-ahead.

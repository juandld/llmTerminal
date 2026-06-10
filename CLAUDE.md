# llmTerminal — Agent Instructions

> **See `ARCHITECTURE.md` for the north star + the current module map.** As of
> 2026-06-11 server.js (4167->~1233 ln) and app.js (4401->472 ln) are decomposed
> into `web/src/` and `web/public/app-*.js` modules; line numbers below may be stale.

You are working on the web chat infrastructure (`web/`) that runs your own UI at `https://hero.camofiles.app/terminal/`. Be careful: a sloppy restart drops every active chat tab, including the one you're talking to David in. Read this before touching code or services.

## Restart rules — **read this first if you change `web/`**

The chat backend is `llm-terminal.service`, systemd-managed, `Restart=always`, KillMode=mixed.

### ✅ Do this

- **Use `systemctl restart llm-terminal`** via the host-restart-helper bridge (see below) or your sudoers entry if you have one. This sends SIGTERM, runs the graceful-shutdown handler (60s grace, waits for in-flight prompts), then a clean systemd respawn.
- After restart, **verify** with `systemctl is-active llm-terminal` and tail journal: `journalctl -u llm-terminal --since "10 seconds ago" --no-pager`.

### ❌ Never do this

- **`kill -9` (SIGKILL) the llm-terminal node process.** SIGKILL skips the graceful-shutdown handler, drops every WS connection including David's (so he loses the chat he's looking at *while you're trying to help him*), orphans claude subprocesses, and makes the UI look broken for reasons unrelated to your actual code change.
- **`kill <pid>` followed by `kill -9 <pid>` because the first didn't work fast enough.** It "didn't work" because the graceful handler is doing its job. Wait the 60s. Use `systemctl restart` instead of pid killing.
- **Manual restart loops while diagnosing.** If you restart 3+ times in 5 min, stop. The problem is upstream of the restart cycle — usually a bug in your latest edit. Read the journal, don't keep cycling.

### Restart paths in order of preference

1. **From the dashboard `Restart` button on `hero.camofiles.app/`** — already wired to call the host-restart-helper. David can tap this.
2. **`POST /api/services/llmTerminal/restart`** to `localhost:8000` from inside the nh-backend container.
3. **Direct socket call** if you have shell + the socket is mounted: `echo '{"unit":"llm-terminal","action":"restart"}' | nc -U /run/hero-restart/restart.sock` (in nh-backend, since it's bind-mounted there).
4. **`sudo systemctl restart llm-terminal`** if you somehow have root sudoers — but this means you're running outside the normal sandbox and should know exactly what you're doing.

## Cache busting + reloads

`server.js` already rewrites `index.html` on the fly to add `?v=<mtime>` cache-busters on `app.js` / `styles.css`. So `nginx` and the browser will pull fresh assets on every navigation after a file change. You don't need to restart the service for a CSS or `app.js` edit — David just needs a hard refresh.

**You do need to restart for** `server.js` changes, any new top-level `require`, or anything in `web/src/`.

## Diagnosing "it looks broken on my phone"

1. **Don't theorize.** Open Playwright at the exact viewport the user described (iPhone 14/15 is 390×844 portrait, with 59px notch top + 34px home-indicator bottom).
2. **Take a screenshot.** Compare to what you expect.
3. **Use the actual page CSS variables.** `viewport-fit=cover` is already set in `index.html`, so `env(safe-area-inset-top)` works for notch-aware layouts.
4. **If the user says "I reloaded and it goes back to broken"** — they are reporting consistent behavior, not a flicker. Check whether your fix actually shipped (look at the served file via `curl -s http://localhost:7683/styles.css | grep <your-new-rule>`). If your edit didn't land, you didn't save it. If it did land but the page still looks broken, your fix was wrong — find a different root cause, don't restart and pray.

## Synthetic "no summary" marker

`server.js` saves a placeholder assistant message ("_Agent finished its tool work without a written summary_") when a Claude run ends with tools used but no closing text. Guard at `server.js:~3430`:

```js
else if (lastToolUse && !_assistantTextEmittedThisTurn) { ... }
```

The `_assistantTextEmittedThisTurn` flag is flipped whenever ANY streamed text block has content. So if you see a synthetic marker that shouldn't be there: it means the real text streamed but the final `data.result` field was empty — likely a stream-json edge case. Don't remove the guard; investigate why the result field came back empty.

## When in doubt about a code change

- **`node --check web/server.js`** before any restart. Catches syntax errors fast.
- **Diff your change** before applying: `git diff web/` from the host. If the diff is bigger than you expected, you've probably been editing in the wrong place.
- **One restart per round of edits.** Batch your changes, restart once, verify once.

## Project layout (quick map)

- `web/server.js` — bootstrap + HTTP routes only now; the run-loop, WS handler,
  providers, supervisors, store, etc. live in `web/src/*` (see ARCHITECTURE.md §6)
- `web/public/app.js` + `app-*.js` — frontend, decomposed into classic-script
  modules (NOT ES modules — preserves the path cache-bust). See ARCHITECTURE.md §6
- `web/public/app-email-draft.js` — email draft action card rendering (loaded after app.js)
- `web/public/styles.css` — all CSS
- `web/public/index.html` — single page
- `web/src/mcp/` — the bridge that makes Claude's MCP tools work on OpenAI/Gemini
- `web/config/projects.json` — source of truth for per-project browser/CDP ports
- `web/scripts/sync-config.py` — regenerates systemd/nginx/.claude.json from projects.json

## Common mistakes to avoid

- **Editing `index.html` to add cache-busters manually.** Don't — `rewriteCacheBust()` in `server.js` does it server-side at every `/` fetch.
- **Editing `styles.css` to add `viewport-fit=cover`.** It's already in `index.html`'s `<meta name="viewport">`.
- **Adding a service worker.** There isn't one. Don't add one without explicit approval — caches will get worse before they get better.
- **Touching `BROWSER_CDP_PORTS` in `server.js` manually.** It's between `>>> llmTerminal-managed >>>` markers, regenerated by `sync-config.py` from `projects.json`. Edit the JSON, run the script.

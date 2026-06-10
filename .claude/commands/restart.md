# /restart — Restart a Hero service safely

Restart a systemd-managed Hero service via the host-restart-helper unix socket. This is the **only** approved way to restart `llm-terminal` (the chat backend you're running inside) and other systemd-managed Hero services from any agent session.

## When to use

- You edited `web/server.js` and need it reloaded.
- You changed a `.service` unit file via `daemon-reload` and need the unit cycled.
- A service is misbehaving and you've already diagnosed *why* — the restart is the deploy, not the diagnostic.

## When NOT to use

- **You're guessing.** If you don't know why a service is broken, restarting won't help; it'll just hide the symptom and reset state you needed to inspect.
- **You've restarted 2+ times already in the last 5 minutes.** Something upstream is wrong. Stop. Read the journal: `journalctl -u <unit> --since "5 minutes ago" --no-pager`.
- **CSS or `app.js` changes for the chat UI.** `server.js` already rewrites `index.html` to add `?v=<mtime>` cache-busters. The user just needs a hard refresh. No restart.
- **You're about to use `kill -9` instead.** Never. SIGKILL skips graceful shutdown, drops the user's active WebSocket (including yours), orphans subprocesses, and makes the UI look broken for reasons unrelated to your actual code change.

## Rate limits (enforced server-side by hero-restart-helper)

Read-only actions (`status`, `is-active`) are **never rate-limited**. State-changing actions (`restart`, `start`, `stop`) are limited per unit:

| Limit | Default | What it stops |
|---|---|---|
| Per-unit cooldown | 20 s | Spamming the same unit; gives graceful-shutdown time to complete |
| Per-unit hourly cap | 6 / hr | A confused agent restart-looping into oblivion |
| Per-unit daily cap | 30 / 24h | A day-long agent flap |
| Global hourly cap | 30 / hr | Cross-unit hammering across all services |

When you hit a limit, the response looks like:
```json
{"ok": false, "rate_limited": true, "error": "cooldown: 'llm-terminal' was restarted 4.2s ago; wait 16s"}
```

**Treat `rate_limited: true` as a hard stop.** Do not retry in a loop. Tell the user, then do something else (diagnose, batch your remaining changes, etc.).

## Audit log

Every request — successful, blocked, or errored — is logged JSON-lines to `/var/log/hero-restart-helper.log`. Each entry includes peer PID/UID so post-mortem can identify which subprocess made which call. If David asks "why did llm-terminal restart 5 times last hour" you can tail it.

## How to use

Call this skill, passing the service name as `$ARGUMENTS`. Allowlisted units:

- `llm-terminal` — the chat backend you're running inside (this matters: the WS that delivers your reply will drop and reconnect)
- `hostchat` — production HostChat
- `hostchat-dev` — dev HostChat (autoreloads on file change; rarely needs manual restart)
- `oshero-daemon`
- `cloudflared`
- `hero-dispatch`
- `queue-supervisor`
- `chromium-camohero` / `chromium-crankhero` / `chromium-langhero` / `chromium-llmterminal` / `chromium-orchestratorhero`

### Steps to perform

1. **Pick the unit.** If the user said "restart it" without specifying, ask. Default for "restart the chat" / "restart llmTerminal" → `llm-terminal`.

2. **Warn the user, especially for `llm-terminal`.**
   > Restarting `llm-terminal` will drop your current chat WebSocket for ~3 seconds. The page auto-reconnects but you'll see a momentary "disconnected" indicator. Continue?

3. **Call the helper via the unix socket.** From inside any sandbox where `/run/hero-restart/restart.sock` is mounted (camoHero, the nh-backend container, etc.):

   ```bash
   python3 -c "
   import socket, json
   s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
   s.settimeout(35)
   s.connect('/run/hero-restart/restart.sock')
   s.send((json.dumps({'unit': '$ARGUMENTS', 'action': 'restart'}) + '\n').encode())
   buf = b''
   while True:
       c = s.recv(4096)
       if not c: break
       buf += c
       if b'\n' in buf: break
   print(buf.decode().strip())
   s.close()
   "
   ```

   Or via HTTP if you're in nh-backend (FastAPI route already exists):
   ```bash
   curl -sS -X POST http://localhost:8000/api/services/<unit-mapped-key>/restart
   ```
   The endpoint maps `llmTerminal` → unit `llm-terminal`. Other keys: see `SIBLING_SERVICES` in `narrativeHero/backend/routes/compositions.py`.

4. **Parse the response.**
   - Success: `{"ok": true, "code": 0, "unit": "...", "action": "restart", "stdout": "", "stderr": ""}`
   - Rate-limited: `{"ok": false, "rate_limited": true, "error": "..."}` — do NOT retry.
   - Unit error: `{"ok": false, "code": N, "stderr": "..."}` — the actual systemctl failure.

5. **Verify it actually came up.** Wait 3 seconds, then:
   ```bash
   python3 -c "
   import socket, json
   s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
   s.connect('/run/hero-restart/restart.sock')
   s.send(b'{\"unit\":\"$ARGUMENTS\",\"action\":\"is-active\"}\n')
   print(s.recv(4096).decode().strip())
   "
   ```
   Expect `stdout: "active\n"`.

6. **Tell the user what happened in one sentence.** "Restarted `<unit>`, came back active, PID `<n>`."

## Available actions (not just restart)

The helper supports: `restart`, `start`, `stop`, `status`, `is-active`. Default is `restart`. Read-only (`status`, `is-active`) are unlimited; state-changing (`restart`, `start`, `stop`) hit the rate limits above.

## If the socket isn't there

`/run/hero-restart/restart.sock` is on the host. It's bind-mounted into nh-backend and any sandbox configured to mount it. If you don't see it:

- You're in a sandbox that doesn't mount `/run/hero-restart/`. The bwrap for camoHero doesn't include it by default. Ask David to add a mount or do the restart yourself.
- The `hero-restart-helper.service` isn't running. Tell the user: `sudo systemctl status hero-restart-helper`.

## Don't do these

- Don't shell out to `sudo systemctl restart <unit>` — `claude-user` isn't in sudoers for that and it'll fail with a confusing PAM error.
- Don't `kill <pid>` followed by waiting for systemd to respawn. The helper does this cleanly and waits for `Restart=always` to do its job; manual pid killing skips the graceful-shutdown handler and confuses systemd's restart counter.
- Don't add new units to the allowlist mid-session. The allowlist is the security boundary. If you need a new unit allowed, ask David and edit `/usr/local/bin/hero-restart-helper.py` followed by `systemctl restart hero-restart-helper`.
- Don't retry on `rate_limited: true`. The limit exists because something is wrong upstream of the restart — usually you. Diagnose instead.

$ARGUMENTS

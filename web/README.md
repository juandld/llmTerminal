# llmTerminal — `web/`

The Node.js + WebSocket chat UI for Claude Code, accessed at `https://hero.camofiles.app/terminal/`.

## Layout

```
web/
├── server.js              # Express + WS server (still one big file — refactor phase 2)
├── public/index.html      # Frontend (CSS + HTML + JS in one file — refactor phase 3)
├── config/
│   └── projects.json      # Single source of truth: project slugs, CDP/VNC/noVNC ports, colors
├── scripts/
│   ├── sync-config.py     # Regenerate systemd/nginx/.claude.json/noVNC/server.js from projects.json
│   └── add-project.py     # Register a new project + run sync-config
└── docs/
    └── ws-protocol.md     # WebSocket message types (server ↔ client)
```

## Adding a new project with a browser

```bash
sudo python3 web/scripts/add-project.py <slug> "<Display Name>"
# example:
sudo python3 web/scripts/add-project.py datahero dataHero
```

The script picks the next display, VNC port, noVNC port, and CDP port automatically, appends to `projects.json`, creates the Chromium profile dir, then runs `sync-config.py`.

## Re-syncing after manual `projects.json` edits

```bash
sudo python3 web/scripts/sync-config.py            # apply changes
sudo python3 web/scripts/sync-config.py --dry-run  # see what would change
```

This regenerates (only the marked sections, never untracked content):
- `/etc/systemd/system/{xvfb,fluxbox,x11vnc,novnc,chromium}-<slug>.service`
- `/etc/nginx/sites-enabled/narrativehero` (between `# >>> llmTerminal-managed >>>` markers)
- `/home/claude-user/.claude.json` (per-project `mcpServers.playwright` entries)
- `/usr/share/novnc/index.html` (between `/* >>> llmTerminal-managed >>> */` markers)
- `web/server.js` (between `/* >>> llmTerminal-managed >>> */` markers — `BROWSER_CDP_PORTS`)

After regen: systemctl daemon-reload, restart changed units, reload nginx, restart `llm-terminal`.

## Service

```bash
systemctl restart llm-terminal      # restart node server only
journalctl -u llm-terminal -f       # tail logs
```

#!/usr/bin/env python3
"""
sync-config.py — regenerate all per-project plumbing from config/projects.json.

What it touches:
  * /etc/systemd/system/{xvfb,fluxbox,x11vnc,novnc,chromium}-<slug>.service  (full files, owned by us)
  * /etc/nginx/sites-enabled/narrativehero  (only between BEGIN/END markers)
  * /home/claude-user/.claude.json  (only the per-project mcpServers.playwright entry)
  * /usr/share/novnc/index.html  (only between BEGIN/END markers)
  * /home/claude-user/projects/llmTerminal/web/server.js  (only between BEGIN/END markers)

Then: daemon-reload, restart services whose unit file changed, reload nginx, restart llm-terminal.

Usage:  sudo python3 sync-config.py  [--dry-run]
"""
from __future__ import annotations
import json, os, sys, hashlib, subprocess, argparse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent  # web/
CONFIG    = REPO_ROOT / "config" / "projects.json"

CHROME_BIN = "/home/claude-user/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome"
NGINX_SITE = Path("/etc/nginx/sites-enabled/narrativehero")
SYSTEMD_DIR = Path("/etc/systemd/system")
CLAUDE_JSON = Path("/home/claude-user/.claude.json")
NOVNC_INDEX = Path("/usr/share/novnc/index.html")
SERVER_JS   = Path("/home/claude-user/projects/llmTerminal/web/server.js")

BEGIN = "# >>> llmTerminal-managed (do not edit between markers) >>>"
END   = "# <<< llmTerminal-managed <<<"
BEGIN_JS = "/* >>> llmTerminal-managed (do not edit between markers) >>> */"
END_JS   = "/* <<< llmTerminal-managed <<< */"


def render_unit_files(p):
    s, d, vnc, nvnc, cdp = p["slug"], p["display"], p["vnc_port"], p["novnc_port"], p["cdp_port"]
    profile = f"/home/claude-user/.chromium-{s}"
    # profile_dir picks which sub-profile Chromium opens inside the user-data-dir.
    # Multiple profiles + no flag => profile picker (CDP reports browser_ui only,
    # so /api/browser-status returns url=null and llmTerminal hides the link).
    profile_dir = p.get("profile_dir", "Default")
    units = {}
    units[f"xvfb-{s}.service"] = f"""[Unit]
Description=Xvfb display :{d} for {s} browser
After=network.target

[Service]
Type=simple
User=claude-user
Group=claude-user
ExecStart=/usr/bin/Xvfb +extension RANDR +extension RENDER :{d} -screen 0 1280x800x24 -ac -nolisten tcp
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
"""
    units[f"fluxbox-{s}.service"] = f"""[Unit]
Description=Fluxbox WM for {s} (display :{d})
After=xvfb-{s}.service
Requires=xvfb-{s}.service

[Service]
Type=simple
User=claude-user
Group=claude-user
Environment=DISPLAY=:{d}
Environment=HOME=/home/claude-user
ExecStart=/usr/bin/fluxbox
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
"""
    units[f"x11vnc-{s}.service"] = f"""[Unit]
Description=x11vnc for {s} (display :{d} -> port {vnc})
After=xvfb-{s}.service
Requires=xvfb-{s}.service

[Service]
Type=simple
User=claude-user
Group=claude-user
Environment=DISPLAY=:{d}
ExecStart=/usr/bin/x11vnc -display :{d} -nopw -listen 127.0.0.1 -rfbport {vnc} -shared -forever -quiet -noxdamage -repeat
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
"""
    units[f"novnc-{s}.service"] = f"""[Unit]
Description=websockify for {s} (port {nvnc} -> 127.0.0.1:{vnc})
After=x11vnc-{s}.service
Requires=x11vnc-{s}.service

[Service]
Type=simple
User=claude-user
Group=claude-user
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:{nvnc} 127.0.0.1:{vnc}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
"""
    units[f"chromium-{s}.service"] = f"""[Unit]
Description=Persistent Chromium for {s} (CDP port {cdp}, profile {profile})
After=xvfb-{s}.service fluxbox-{s}.service
Requires=xvfb-{s}.service fluxbox-{s}.service

[Service]
Type=simple
User=claude-user
Group=claude-user
Environment=DISPLAY=:{d}
Environment=HOME=/home/claude-user
Environment=LANG=en_US.UTF-8
ExecStart={CHROME_BIN} \\
  --no-sandbox \\
  --user-data-dir={profile} \\
  --profile-directory={profile_dir!r} \\
  --remote-debugging-port={cdp} \\
  --remote-debugging-address=127.0.0.1 \\
  --no-first-run \\
  --no-default-browser-check \\
  --disable-features=Translate \\
  --disable-blink-features=AutomationControlled \\
  --window-position=40,40 \\
  --window-size=1200,720
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
"""
    return units


def write_systemd_units(projects, dry):
    changed = []
    for p in projects:
        units = render_unit_files(p)
        for name, body in units.items():
            target = SYSTEMD_DIR / name
            existing = target.read_text() if target.exists() else ""
            if existing.strip() != body.strip():
                changed.append(name)
                if not dry:
                    target.write_text(body)
    return changed


def replace_block(text, begin, end, new_content):
    if begin not in text:
        return text + "\n" + begin + "\n" + new_content + "\n" + end + "\n"
    pre = text.split(begin)[0]
    post = text.split(end, 1)[1] if end in text else ""
    return pre + begin + "\n" + new_content.rstrip("\n") + "\n" + end + post


def update_nginx(projects, dry):
    if not NGINX_SITE.exists():
        return False
    src = NGINX_SITE.read_text()
    block_lines = []
    for p in projects:
        block_lines.append(f"""    location /vnc/{p['slug']}/ {{
        if ($is_david = 0) {{ return 403; }}
        proxy_pass http://127.0.0.1:{p['novnc_port']}/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
        proxy_buffering off;
    }}""")
    managed = "    # noVNC per-project routes (regenerated by sync-config.py)\n" + "\n".join(block_lines)
    new_src = replace_block(src, "    " + BEGIN, "    " + END, managed)
    if new_src == src:
        return False
    if not dry:
        NGINX_SITE.write_text(new_src)
    return True


def update_claude_json(projects, dry):
    raw = json.loads(CLAUDE_JSON.read_text())
    changed = False
    for p in projects:
        proj_path = p["project_path"]
        cdp = p["cdp_port"]
        entry = raw.setdefault("projects", {}).setdefault(proj_path, {})
        mcps = entry.setdefault("mcpServers", {})
        desired = {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@playwright/mcp@latest", f"--cdp-endpoint=http://127.0.0.1:{cdp}"],
            "env": {"HOME": "/home/claude-user", "PATH": "/usr/local/bin:/usr/bin:/bin"},
        }
        if mcps.get("playwright") != desired:
            mcps["playwright"] = desired
            changed = True
    if changed and not dry:
        CLAUDE_JSON.write_text(json.dumps(raw, indent=2))
    return changed


def update_novnc(projects, dry, reserved):
    src = NOVNC_INDEX.read_text()
    lines = []
    for p in projects:
        lines.append(f"    {p['slug']:14}: {{ name: '{p['name']}', color: '{p['color']}' }},")
    for slug, color in reserved.items():
        lines.append(f"    {slug:14}: {{ name: '{slug}', color: '{color}' }}, // reserved")
    managed_js = "    // PROJECTS map regenerated by sync-config.py\n" + "\n".join(lines)
    new_src = replace_block(src, "    " + BEGIN_JS, "    " + END_JS, managed_js)
    if new_src == src:
        return False
    if not dry:
        NOVNC_INDEX.write_text(new_src)
    return True


def update_server_js(projects, dry):
    src = SERVER_JS.read_text()
    lines = ["// BROWSER_CDP_PORTS regenerated by sync-config.py", "const BROWSER_CDP_PORTS = {"]
    for p in projects:
        lines.append(f"  {p['slug']}: {p['cdp_port']},")
    lines.append("};")
    managed_js = "\n".join(lines)
    new_src = replace_block(src, BEGIN_JS, END_JS, managed_js)
    if new_src == src:
        return False
    if not dry:
        SERVER_JS.write_text(new_src)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cfg = json.loads(CONFIG.read_text())
    projects = cfg["projects"]
    dry = args.dry_run

    print(f"sync-config.py — {len(projects)} projects, dry-run={dry}")
    changed_units   = write_systemd_units(projects, dry)
    nginx_changed   = update_nginx(projects, dry)
    claude_changed  = update_claude_json(projects, dry)
    novnc_changed   = update_novnc(projects, dry, cfg.get('reserved_colors', {}))
    server_changed  = update_server_js(projects, dry)

    print(f"  systemd units changed: {len(changed_units)}")
    for n in changed_units: print(f"    - {n}")
    print(f"  nginx changed:       {nginx_changed}")
    print(f"  .claude.json changed:{claude_changed}")
    print(f"  noVNC wrapper changed:{novnc_changed}")
    print(f"  server.js changed:   {server_changed}")

    if dry:
        print("(dry-run — no actions taken)")
        return

    if changed_units:
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        for unit in changed_units:
            subprocess.run(["systemctl", "enable", "--now", unit], check=False)
            subprocess.run(["systemctl", "restart", unit], check=False)
        print(f"  restarted {len(changed_units)} units")

    if nginx_changed:
        r = subprocess.run(["nginx", "-t"], capture_output=True)
        if r.returncode != 0:
            print("  nginx -t failed:", r.stderr.decode())
            sys.exit(1)
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
        print("  reloaded nginx")

    if server_changed:
        r = subprocess.run(["node", "--check", str(SERVER_JS)], capture_output=True)
        if r.returncode != 0:
            print("  server.js syntax error:", r.stderr.decode())
            sys.exit(1)
        subprocess.run(["systemctl", "restart", "llm-terminal"], check=True)
        print("  restarted llm-terminal")

    print("sync-config.py done.")


if __name__ == "__main__":
    main()

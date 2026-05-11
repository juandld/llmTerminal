#!/usr/bin/env python3
"""
add-project.py — register a new project in projects.json + run sync-config.

Usage:
  sudo python3 add-project.py <slug> "<Display Name>" [<color>]

  slug:         lowercase alnum (e.g. "datahero")
  Display Name: human-readable name (e.g. "dataHero")
  color:        hex color (optional; uses reserved_colors if matching, else picks)

Examples:
  sudo python3 add-project.py datahero dataHero
  sudo python3 add-project.py mediahero mediaHero "#E91E63"
"""
import json, os, re, sys, subprocess
from pathlib import Path

ROOT   = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "projects.json"

if len(sys.argv) < 3:
    print(__doc__); sys.exit(2)
slug = sys.argv[1].strip().lower()
name = sys.argv[2].strip()
color = sys.argv[3] if len(sys.argv) > 3 else None

if not re.fullmatch(r"[a-z][a-z0-9]+", slug):
    sys.exit(f"slug must be lowercase alnum, got: {slug}")

cfg = json.loads(CONFIG.read_text())
existing = {p["slug"] for p in cfg["projects"]}
if slug in existing:
    sys.exit(f"project '{slug}' already exists in projects.json")

# Pick next display + ports
displays   = [p["display"]    for p in cfg["projects"]]
vnc_ports  = [p["vnc_port"]   for p in cfg["projects"]]
novnc_ports= [p["novnc_port"] for p in cfg["projects"]]
cdp_ports  = [p["cdp_port"]   for p in cfg["projects"]]
display     = max(displays)    + 1 if displays    else 99
vnc_port    = max(vnc_ports)   + 1 if vnc_ports   else 5900
novnc_port  = max(novnc_ports) + 1 if novnc_ports else 6080
cdp_port    = max(cdp_ports)   + 1 if cdp_ports   else 9222

# Resolve color: arg > reserved_colors[slug] > pick a default
reserved = cfg.get("reserved_colors", {})
if not color:
    color = reserved.get(slug, "#666666")

# Resolve project path: convention is /home/claude-user/projects/<CamelCaseName>
project_path = f"/home/claude-user/projects/{name}"
if not Path(project_path).is_dir():
    print(f"WARNING: {project_path} does not exist — the project chat will still work but ensure the path is correct.", file=sys.stderr)

new_entry = {
    "slug": slug,
    "name": name,
    "project_path": project_path,
    "display": display,
    "vnc_port": vnc_port,
    "novnc_port": novnc_port,
    "cdp_port": cdp_port,
    "color": color,
}
cfg["projects"].append(new_entry)

# Remove from reserved_colors if it was there (it's now active)
cfg.get("reserved_colors", {}).pop(slug, None)

CONFIG.write_text(json.dumps(cfg, indent=2) + "\n")
print(f"added {slug} → display :{display}, CDP {cdp_port}, noVNC {novnc_port}, color {color}")

# Create the chromium profile dir under claude-user
profile_dir = f"/home/claude-user/.chromium-{slug}"
subprocess.run(["sudo", "-u", "claude-user", "mkdir", "-p", profile_dir], check=False)

# Hand off to sync-config to regenerate everything
print("running sync-config…")
subprocess.run(["sudo", "python3", str(ROOT / "scripts" / "sync-config.py")], check=True)

print(f"\nDone. Browser URL: https://hero.camofiles.app/vnc/{slug}/")

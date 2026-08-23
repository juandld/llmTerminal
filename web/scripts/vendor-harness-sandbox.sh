#!/usr/bin/env bash
# vendor-harness-sandbox.sh — clone, install, run, and tear down a vendor's
# dev-preview harness for research, without OOMing the VPS or leaking
# detached processes past this session. Generalizes the dsh clone->install->
# run pattern (see HARNESS_PLAN.md, 2026-08-23 "How dsh actually got
# running") so it doesn't get redone by hand every time a new vendor tool
# needs a look.
#
# Usage:
#   vendor-harness-sandbox.sh start <name> <git-url> <port> [install-cmd] [start-cmd]
#   vendor-harness-sandbox.sh status [name]
#   vendor-harness-sandbox.sh logs <name>
#   vendor-harness-sandbox.sh stop <name>
#   vendor-harness-sandbox.sh clean <name>   # stop + delete the clone
#
# Defaults: install-cmd = "pnpm install" if pnpm-lock.yaml is present in the
# repo root else "npm install"; start-cmd = "pnpm dev --port <port>" —
# override both when a vendor's own README says otherwise.
#
# Lessons baked in (see HARNESS_PLAN.md's dsh entry — two silent OOMs before
# this was worked out):
#   - NEVER use npx for the initial fetch. Fresh dependency resolution every
#     time is slow and was the exact OOM trigger before. git clone once,
#     install locally — 17s vs OOM on this VPS's 15GB.
#   - ALWAYS launch the long-running serve command via setsid+nohup+disown so
#     it survives this shell/session ending. A bare `&` dies with the parent
#     on session-boundary teardown — independent of memory pressure, and easy
#     to misattribute to OOM if you don't know to check for it separately.
#   - Clean up when the research pass is done — `clean` kills the process
#     AND deletes the clone. A sandbox is scratch space, not a service.
set -euo pipefail

STATE_DIR="${HOME}/.llm-terminal"
STATE_FILE="${STATE_DIR}/vendor-sandboxes.json"
SANDBOX_ROOT="${STATE_DIR}/vendor-sandboxes"
mkdir -p "$STATE_DIR" "$SANDBOX_ROOT"
[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

cmd="${1:-}"

case "$cmd" in
  start)
    name="${2:?usage: start <name> <git-url> <port> [install-cmd] [start-cmd]}"
    url="${3:?usage: start <name> <git-url> <port> [install-cmd] [start-cmd]}"
    port="${4:?usage: start <name> <git-url> <port> [install-cmd] [start-cmd]}"
    install_cmd="${5:-}"
    start_cmd="${6:-}"
    workdir="$SANDBOX_ROOT/$name"

    if [ -d "$workdir" ]; then
      echo "[vendor-sandbox] $name already cloned at $workdir — reusing (rm -rf it first for a fresh clone)"
    else
      echo "[vendor-sandbox] cloning $url -> $workdir"
      git clone --depth 1 "$url" "$workdir"
    fi

    cd "$workdir"
    if [ -z "$install_cmd" ]; then
      if [ -f pnpm-lock.yaml ]; then install_cmd="pnpm install"; else install_cmd="npm install"; fi
    fi
    echo "[vendor-sandbox] installing: $install_cmd"
    eval "$install_cmd"

    if [ -z "$start_cmd" ]; then start_cmd="pnpm dev --port $port"; fi
    log_file="$SANDBOX_ROOT/$name.log"
    echo "[vendor-sandbox] starting (detached, survives session end): $start_cmd"
    echo "[vendor-sandbox] log: $log_file"
    setsid nohup bash -c "$start_cmd" > "$log_file" 2>&1 < /dev/null &
    pid=$!
    disown

    node -e "
      const fs=require('fs');
      const s=JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
      s['$name']={pid:$pid,port:$port,workdir:'$workdir',url:'$url',startedAt:Date.now(),logFile:'$log_file'};
      fs.writeFileSync('$STATE_FILE', JSON.stringify(s,null,2));
    "
    echo "[vendor-sandbox] $name started — pid=$pid port=$port"
    echo "[vendor-sandbox] check: $0 status $name   |   tail: $0 logs $name   |   when done: $0 clean $name"
    ;;

  status)
    name="${2:-}"
    node -e "
      const fs=require('fs');
      const s=JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
      const names = '$name' ? ['$name'] : Object.keys(s);
      if (!names.length) { console.log('[vendor-sandbox] no sandboxes recorded'); process.exit(0); }
      for (const n of names) {
        const e = s[n];
        if (!e) { console.log(n, '- not found'); continue; }
        let alive=false;
        try { process.kill(e.pid, 0); alive=true; } catch {}
        console.log((alive?'RUNNING':'DEAD   '), n, 'pid='+e.pid, 'port='+e.port, e.workdir);
      }
    "
    ;;

  logs)
    name="${2:?usage: logs <name>}"
    log_file=$(node -e "
      const fs=require('fs');
      const s=JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
      const e=s['$name'];
      if(!e){console.error('[vendor-sandbox] not found: $name');process.exit(1);}
      console.log(e.logFile);
    ")
    tail -n 80 "$log_file"
    ;;

  stop)
    name="${2:?usage: stop <name>}"
    node -e "
      const fs=require('fs');
      const s=JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
      const e=s['$name'];
      if(!e){console.error('[vendor-sandbox] not found: $name');process.exit(1);}
      try { process.kill(-e.pid, 'SIGTERM'); } catch(err) { try{process.kill(e.pid,'SIGTERM');}catch{} }
      console.log('[vendor-sandbox] stopped', '$name', 'pid='+e.pid);
    "
    ;;

  clean)
    name="${2:?usage: clean <name>}"
    "$0" stop "$name" || true
    workdir="$SANDBOX_ROOT/$name"
    node -e "
      const fs=require('fs');
      const s=JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
      delete s['$name'];
      fs.writeFileSync('$STATE_FILE', JSON.stringify(s,null,2));
    "
    rm -rf "$workdir" "$SANDBOX_ROOT/$name.log"
    echo "[vendor-sandbox] cleaned $name ($workdir removed)"
    ;;

  *)
    echo "Usage: $0 {start|status|logs|stop|clean} ..." >&2
    echo "  start <name> <git-url> <port> [install-cmd] [start-cmd]" >&2
    echo "  status [name]" >&2
    echo "  logs <name>" >&2
    echo "  stop <name>" >&2
    echo "  clean <name>   # stop + delete the clone" >&2
    exit 1
    ;;
esac

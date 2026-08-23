---
name: vendor-harness-sandbox
description: Clone, install, run, and tear down a third-party agent-harness or dev-tool repo (dsh-style research: "go look at how vendor X's harness works/looks") in an isolated, detached sandbox that survives session end without OOMing the VPS or leaking processes. Use whenever asked to run/try/inspect another vendor's harness, CLI, or dev-preview tool locally rather than just reading its source on GitHub.
---

# vendor-harness-sandbox — run a vendor's tool locally without the OOM/leak trap

Generalizes the pattern first worked out running DeepSeek's `dsh` locally
(see HARNESS_PLAN.md, 2026-08-23, "How dsh actually got running") into a
reusable script: `web/scripts/vendor-harness-sandbox.sh`. Two silent
failures happened before this existed — worth knowing WHY so you don't
re-discover them the hard way:

1. **`npx <vendor-tool>` OOM'd twice, silently, no diagnostic output.**
   `npx` re-resolves the whole dependency tree fresh every invocation, which
   is expensive on a 2 vCPU / 15GB box already running several chromium
   instances. `git clone` + a local `pnpm install`/`npm install` is far
   cheaper (17s vs OOM in the dsh case) — always prefer it for anything
   beyond a one-shot CLI invocation.
2. **A background process launched with a bare `&` dies when the spawning
   session/shell ends** — independent of memory pressure, and easy to
   misdiagnose as "it OOM'd again" when actually the parent just exited.
   Always launch the long-running serve command with `setsid nohup ... <
   /dev/null > logfile 2>&1 & disown` so it detaches fully.

## When to use this

- David (or a research task) asks you to actually run/try a vendor's agent
  harness, CLI tool, or dev-preview server locally — not just read its
  source on GitHub. Reading source doesn't tell you what a UI/interaction
  actually feels like; running it does.
- You need the tool serving on a port you can hit with Playwright or curl
  for a research pass, then want it gone afterward — this is scratch
  infrastructure for a research pass, not a new permanent service. Don't
  register it in `web/config/projects.json` or give it a systemd unit
  unless the research concludes it should become a permanent fixture (a
  separate, explicit decision — flag it to David, don't just leave it
  running).

## Usage

```bash
web/scripts/vendor-harness-sandbox.sh start <name> <git-url> <port> [install-cmd] [start-cmd]
web/scripts/vendor-harness-sandbox.sh status [name]
web/scripts/vendor-harness-sandbox.sh logs <name>
web/scripts/vendor-harness-sandbox.sh stop <name>
web/scripts/vendor-harness-sandbox.sh clean <name>   # stop + delete the clone
```

- `name` is your own label (e.g. `dsh`) — state (pid, port, workdir, log
  path) is tracked in `~/.llm-terminal/vendor-sandboxes.json`; the clone
  itself lives under `~/.llm-terminal/vendor-sandboxes/<name>/`.
- Omit `install-cmd`/`start-cmd` to use the defaults (`pnpm install` if
  `pnpm-lock.yaml` exists else `npm install`; `pnpm dev --port <port>`) —
  override both when the vendor's own README says otherwise (some tools use
  `npm run dev`, a different flag for the port, a build step first, etc. —
  read their README before guessing).
- `start` is idempotent on the clone: re-running `start` with an existing
  `name` reuses the already-cloned directory instead of re-cloning. Delete
  the workdir yourself (or run `clean` first) for a genuinely fresh clone.

## After the research pass

Always run `clean <name>` once you've gotten what you needed (a screenshot,
an understanding of an interaction pattern, source you can point at) —
matches the dsh precedent: killed the server, closed the tab, no lingering
process. If the research concludes a vendor pattern is worth ADOPTING
permanently in this codebase (like the Decisions timeline strip was), that's
a separate, explicit port into this repo's own code — not leaving the
vendor's sandbox running as the "real" implementation.

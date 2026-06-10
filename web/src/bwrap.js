// bwrap sandbox wrapper for claude spawns. Leaf module (no internal deps) so both
// providers/claude and session-title use it without a require cycle. Extracted 2026-06-11.

const SANDBOXED_PROJECTS = new Set(["camoHero"]);
function _bwrapWrap(project, claudeArgs) {
  if (!SANDBOXED_PROJECTS.has(project)) {
    return { cmd: "/usr/bin/claude", args: claudeArgs };
  }
  const projDir = "/home/claude-user/projects/" + project;
  const args = [
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/etc", "/etc",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve",
    "--tmpfs", "/home/claude-user",
    // Make /home/claude-user/projects a read-only tmpfs. The project's own dir
    // gets re-bound rw below. Any write to other paths under projects/ (e.g. an
    // agent scaffolding into /home/claude-user/projects/foo/) fails with EROFS
    // instead of silently disappearing into the parent tmpfs on bwrap exit.
    "--tmpfs", "/home/claude-user/projects",
    "--dir", projDir,
    "--remount-ro", "/home/claude-user/projects",
    "--bind", projDir, projDir,
    "--bind", "/home/claude-user/.claude", "/home/claude-user/.claude",
    "--ro-bind", "/home/claude-user/.claude.json", "/home/claude-user/.claude.json",
    "--bind", "/home/claude-user/.local", "/home/claude-user/.local",
    "--bind", "/home/claude-user/.cache", "/home/claude-user/.cache",
    "--bind", "/home/claude-user/.npm", "/home/claude-user/.npm",
    "--bind", "/home/claude-user/.config", "/home/claude-user/.config",
    // RO-bind the llmTerminal uploads dir so the agent can read screenshots /
    // images the user attaches. Other ll-terminal state (sessions.db,
    // sessions.json, permissions/) stays out of the sandbox.
    "--ro-bind", "/home/claude-user/.llm-terminal/uploads", "/home/claude-user/.llm-terminal/uploads",
    "--bind", "/tmp", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--", "/usr/bin/claude",
    ...claudeArgs,
  ];
  return { cmd: "/usr/bin/bwrap", args };
}

module.exports = { _bwrapWrap, SANDBOXED_PROJECTS };

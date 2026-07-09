"use strict";

// Built-in tools for non-Claude providers (OpenAI / Gemini).
//
// Claude has Bash/Read/Edit/Write/Grep/Glob as native tools — OpenAI and Gemini
// don't. Without these the non-Claude providers can only call MCP tools
// (browser_*, draft_email, llmt_*), which means they can't read, edit, search,
// or run a shell command. This module gives them the same minimal toolkit.
//
// Names + summary shapes deliberately match Claude's so:
//   - summarizeToolUse() in tools.js renders them with the same per-tool label
//   - autoCreatePreview() pins files for Write/Edit/Read
//   - autoDetectBashFiles() scans Bash stdout for new files
// No UI changes needed when these dispatch from OpenAI / Gemini.
//
// Safety: all file writes are restricted to under the session's project dir.
// Reads are restricted too — the model can't slurp /etc/passwd. Bash is *not*
// path-restricted (a model will need to e.g. `git log` outside cwd? rarely; if
// David hits this we can revisit), but it inherits the projectCwd as cwd.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { PROJECTS_DIR } = require("./paths");

const MAX_RESULT_CHARS = 16000;
const BASH_DEFAULT_TIMEOUT_MS = 120000;
const BASH_MAX_TIMEOUT_MS = 600000;

function _truncate(s, max = MAX_RESULT_CHARS) {
  if (typeof s !== "string") s = String(s ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n…(truncated, full output was ${s.length} chars)`;
}

// Resolve a file path safely. Absolute paths must be under projectCwd; relative
// paths resolve against projectCwd. Throws if the resolved path escapes.
function _resolveInsideProject(p, projectCwd, { allowOutsideForRead = false } = {}) {
  if (!projectCwd) throw new Error("No active project — file ops unavailable.");
  if (typeof p !== "string" || !p.trim()) throw new Error("Path is required.");
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(projectCwd, p);
  const projAbs = path.resolve(projectCwd);
  const inside = abs === projAbs || abs.startsWith(projAbs + path.sep);
  if (!inside && !allowOutsideForRead) {
    throw new Error(`Path "${p}" is outside the project dir ${projectCwd}. Writes must stay inside the project.`);
  }
  if (!inside) {
    // Reads outside the project — allow but only under /home/claude-user (no /etc, /root, etc.)
    const HOME = "/home/claude-user";
    if (abs !== HOME && !abs.startsWith(HOME + path.sep)) {
      throw new Error(`Read path "${p}" is outside ${HOME}.`);
    }
  }
  return abs;
}

const TOOLS = [
  {
    name: "Bash",
    description:
      "Run a shell command in the project's working directory. Returns combined stdout + stderr (truncated to 16K). " +
      "Use for: git operations, running tests, npm/pip commands, listing files, anything not covered by Read/Write/Edit/Grep/Glob. " +
      "Prefer Read/Write/Edit over cat/echo/sed when you can.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        timeout: {
          type: "integer",
          description: `Timeout in milliseconds (default ${BASH_DEFAULT_TIMEOUT_MS}, max ${BASH_MAX_TIMEOUT_MS}).`,
        },
        description: {
          type: "string",
          description: "Optional short description of what this command does (for UI).",
        },
      },
    },
    async execute({ command, timeout }, ctx) {
      if (typeof command !== "string" || !command.trim()) {
        throw new Error("`command` is required and must be a non-empty string.");
      }
      const cwd = ctx.projectCwd || "/tmp";
      const tmo = Math.min(
        Math.max(parseInt(timeout, 10) || BASH_DEFAULT_TIMEOUT_MS, 1000),
        BASH_MAX_TIMEOUT_MS,
      );
      return await new Promise((resolve) => {
        const proc = spawn("/bin/bash", ["-lc", command], {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let killed = false;
        const limit = MAX_RESULT_CHARS + 4096;
        const append = (s) => {
          if (out.length >= limit) return;
          out += s;
          if (out.length >= limit) {
            try { proc.kill("SIGTERM"); } catch {}
          }
        };
        proc.stdout.on("data", (c) => append(c.toString()));
        proc.stderr.on("data", (c) => append(c.toString()));
        const tmoHandle = setTimeout(() => {
          killed = true;
          try { proc.kill("SIGTERM"); } catch {}
          setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2000);
        }, tmo);
        proc.on("close", (code) => {
          clearTimeout(tmoHandle);
          let result = out || "(no output)";
          if (killed) result = `[command killed after ${tmo}ms timeout]\n` + result;
          if (code !== 0 && !killed) result = `[exit ${code}]\n` + result;
          resolve({ text: _truncate(result), isError: code !== 0, _bashCmd: command, _bashCwd: cwd, _bashStdout: out });
        });
        proc.on("error", (err) => {
          clearTimeout(tmoHandle);
          resolve({ text: `Failed to spawn bash: ${err.message}`, isError: true });
        });
      });
    },
  },

  {
    name: "Read",
    description:
      "Read the contents of a file. Default: returns the FULL text (truncated to 16K if huge). " +
      "Only pass offset/limit when you know the file is too big — for typical source files just call Read with file_path alone.",
    inputSchema: {
      type: "object",
      required: ["file_path"],
      properties: {
        file_path: { type: "string", description: "Absolute path (must be under the project dir or /home/claude-user/) or path relative to the project cwd." },
        offset: { type: "integer", description: "Optional: 1-based line number to start at. Omit to read from line 1." },
        limit: { type: "integer", description: "Optional: max number of lines to return. Omit to read to EOF." },
      },
    },
    async execute({ file_path, offset, limit }, ctx) {
      const abs = _resolveInsideProject(file_path, ctx.projectCwd, { allowOutsideForRead: true });
      let content;
      try {
        content = fs.readFileSync(abs, "utf-8");
      } catch (e) {
        if (e.code === "ENOENT") throw new Error(`File not found: ${abs}`);
        if (e.code === "EISDIR") {
          const entries = fs.readdirSync(abs, { withFileTypes: true })
            .map(d => d.isDirectory() ? d.name + "/" : d.name).join("\n");
          return { text: `(${abs} is a directory)\n${entries}`, isError: false, _absPath: abs };
        }
        throw e;
      }
      const totalLines = content.split("\n").length;
      if (offset || limit) {
        const startLine = Math.max(1, parseInt(offset, 10) || 1);
        if (startLine > totalLines) {
          return {
            text: `[${abs} has ${totalLines} lines; offset ${startLine} is past EOF — file ends here.]`,
            isError: false, _absPath: abs,
          };
        }
        const lines = content.split("\n");
        const start = startLine - 1;
        const end = limit ? start + parseInt(limit, 10) : lines.length;
        const slice = lines.slice(start, end).join("\n");
        const hint = `[lines ${startLine}-${Math.min(end, totalLines)} of ${totalLines}]\n`;
        return { text: _truncate(hint + slice), isError: false, _absPath: abs };
      }
      return { text: _truncate(content), isError: false, _absPath: abs };
    },
  },

  {
    name: "Write",
    description:
      "Write contents to a file (creates or overwrites). Path must be inside the project dir. Parent directories are created automatically. " +
      "For small edits prefer Edit (exact-string replace) — Write rewrites the whole file.",
    inputSchema: {
      type: "object",
      required: ["file_path", "content"],
      properties: {
        file_path: { type: "string", description: "Absolute path under the project dir, or relative to project cwd." },
        content: { type: "string", description: "Full file contents." },
      },
    },
    async execute({ file_path, content }, ctx) {
      const abs = _resolveInsideProject(file_path, ctx.projectCwd);
      if (typeof content !== "string") throw new Error("`content` must be a string.");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");
      return { text: `Wrote ${content.length} chars to ${abs}`, isError: false, _absPath: abs };
    },
  },

  {
    name: "Edit",
    description:
      "Replace an exact string in a file. `old_string` must occur EXACTLY ONCE in the file (or be unique enough that the replacement is unambiguous). " +
      "Set `replace_all: true` to replace every occurrence. Path must be inside the project dir.",
    inputSchema: {
      type: "object",
      required: ["file_path", "old_string", "new_string"],
      properties: {
        file_path: { type: "string", description: "Absolute path under the project dir, or relative to project cwd." },
        old_string: { type: "string", description: "Exact string to replace (must be unique unless replace_all)." },
        new_string: { type: "string", description: "Replacement string." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
      },
    },
    async execute({ file_path, old_string, new_string, replace_all }, ctx) {
      const abs = _resolveInsideProject(file_path, ctx.projectCwd);
      if (typeof old_string !== "string" || !old_string.length) {
        throw new Error("`old_string` is required and must be non-empty.");
      }
      if (typeof new_string !== "string") throw new Error("`new_string` is required.");
      const orig = fs.readFileSync(abs, "utf-8");
      let next;
      let count = 0;
      if (replace_all) {
        const parts = orig.split(old_string);
        count = parts.length - 1;
        if (count === 0) throw new Error(`String not found in ${abs}.`);
        next = parts.join(new_string);
      } else {
        const idx = orig.indexOf(old_string);
        if (idx === -1) throw new Error(`String not found in ${abs}.`);
        if (orig.indexOf(old_string, idx + 1) !== -1) {
          throw new Error(`String is not unique in ${abs}. Pass replace_all:true or include more surrounding context.`);
        }
        count = 1;
        next = orig.slice(0, idx) + new_string + orig.slice(idx + old_string.length);
      }
      fs.writeFileSync(abs, next, "utf-8");
      return { text: `Replaced ${count} occurrence(s) in ${abs}`, isError: false, _absPath: abs };
    },
  },

  {
    name: "Grep",
    description:
      "Recursive content search (POSIX grep -r -E). Returns file:line:match lines (truncated to 16K). " +
      "Excludes common heavy dirs (node_modules, .git, .venv, dist, build).",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "Regex pattern (extended POSIX, like egrep)." },
        path: { type: "string", description: "Path to search (default: project cwd)." },
        case_insensitive: { type: "boolean", description: "Match case-insensitively (-i)." },
        files_with_matches: { type: "boolean", description: "Return file paths only, not matching lines (-l)." },
        include: { type: "string", description: "Filename glob to include, e.g. '*.js'." },
        max_count: { type: "integer", description: "Max matches per file." },
      },
    },
    async execute({ pattern, path: searchPath, case_insensitive, files_with_matches, include, max_count }, ctx) {
      if (typeof pattern !== "string" || !pattern.length) throw new Error("`pattern` is required.");
      const cwd = ctx.projectCwd || "/tmp";
      const args = [
        "-r", "-E", "-n", "-H", "--color=never",
        "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=.venv",
        "--exclude-dir=dist", "--exclude-dir=build", "--exclude-dir=__pycache__",
      ];
      if (case_insensitive) args.push("-i");
      if (files_with_matches) args.push("-l");
      if (include) args.push("--include", include);
      const m = parseInt(max_count, 10);
      if (m > 0) args.push("-m", String(m));
      args.push("-e", pattern);
      args.push(searchPath || ".");
      return await new Promise((resolve) => {
        const proc = spawn("/bin/grep", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        const limit = MAX_RESULT_CHARS + 4096;
        proc.stdout.on("data", (c) => { if (out.length < limit) out += c.toString(); else { try { proc.kill("SIGTERM"); } catch {} } });
        proc.stderr.on("data", (c) => { err += c.toString(); });
        proc.on("close", (code) => {
          // grep exit 1 = no matches; not an error from the model's POV.
          if (code === 0) return resolve({ text: _truncate(out || "(no matches)"), isError: false });
          if (code === 1) return resolve({ text: "(no matches)", isError: false });
          resolve({ text: `[grep exit ${code}] ${err || out}`.slice(0, 4000), isError: true });
        });
        proc.on("error", (e) => resolve({ text: `Failed to spawn grep: ${e.message}`, isError: true }));
      });
    },
  },

  {
    name: "Glob",
    description:
      "Find files by name pattern. Returns matching paths newest-first (modified time). Uses find under the hood.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.js' or 'src/**/foo.*'." },
        path: { type: "string", description: "Directory to search under (default: project cwd)." },
      },
    },
    async execute({ pattern, path: searchPath }, ctx) {
      if (typeof pattern !== "string" || !pattern.length) throw new Error("`pattern` is required.");
      const cwd = ctx.projectCwd || "/tmp";
      const root = searchPath
        ? (path.isAbsolute(searchPath) ? searchPath : path.resolve(cwd, searchPath))
        : cwd;
      // Translate glob to a regex find. Simpler/faster: shell-out to bash globstar.
      const bashCmd = `shopt -s globstar nullglob; for f in ${pattern.replace(/'/g, "'\\''")}; do [ -e "$f" ] && stat -c '%Y	%n' "$f"; done | sort -rn | cut -f2- | head -200`;
      return await new Promise((resolve) => {
        const proc = spawn("/bin/bash", ["-c", bashCmd], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        proc.stdout.on("data", (c) => { out += c.toString(); });
        proc.stderr.on("data", (c) => { err += c.toString(); });
        proc.on("close", (code) => {
          if (code !== 0) return resolve({ text: `[glob exit ${code}] ${err}`.slice(0, 2000), isError: true });
          resolve({ text: _truncate(out || "(no matches)"), isError: false });
        });
        proc.on("error", (e) => resolve({ text: `Failed to spawn bash: ${e.message}`, isError: true }));
      });
    },
  },
];

const _byName = new Map(TOOLS.map(t => [t.name, t]));

function listBuiltinTools() {
  return TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, _builtin: true }));
}

function hasBuiltin(name) {
  return _byName.has(name);
}

/**
 * Execute a built-in tool. Returns { content: [...], isError, _meta }.
 * `_meta` may include `_absPath` (for file ops) or `_bashStdout` (for Bash),
 * so the WS layer can pin files via autoCreatePreview / autoDetectBashFiles.
 */
async function callBuiltin(name, args, ctx) {
  const tool = _byName.get(name);
  if (!tool) throw new Error(`Unknown built-in tool: ${name}`);
  try {
    const r = await tool.execute(args || {}, ctx || {});
    return {
      content: [{ type: "text", text: r.text }],
      isError: !!r.isError,
      _meta: r,
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `${name} failed: ${e.message}` }],
      isError: true,
      _meta: { error: e.message },
    };
  }
}

module.exports = { listBuiltinTools, hasBuiltin, callBuiltin, TOOLS };

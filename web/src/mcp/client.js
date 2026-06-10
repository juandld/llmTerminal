"use strict";
const { spawn } = require("child_process");
const path = require("path");

/**
 * MCP (Model Context Protocol) stdio JSON-RPC client.
 *
 * Spawns a server as a child process, completes the initialize handshake,
 * and exposes listTools() and callTool(). Designed to be shared across
 * multiple chat sessions for the same project — the Playwright MCP itself
 * is just a thin protocol bridge; statefulness lives in the CDP browser
 * which is already per-project.
 */
class MCPClient {
  constructor({ command, args, env, name }) {
    this.command = command;
    this.args = args || [];
    this.env = env || process.env;
    this.name = name || path.basename(command);
    this.proc = null;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this._buf = "";
    this._nextId = 1;
    this._tools = null;
    this._ready = null;
    this._closed = false;
  }

  async start() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      this.proc = spawn(this.command, this.args, {
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc.stdout.on("data", (chunk) => this._onData(chunk));
      this.proc.stderr.on("data", (chunk) => {
        // Demote MCP stderr to a single tagged line per chunk — useful for debugging
        // without flooding journalctl when the server is chatty.
        const s = chunk.toString();
        if (s.trim()) console.warn(`[mcp:${this.name}:stderr] ${s.trim().slice(0, 300)}`);
      });
      this.proc.on("close", (code) => {
        this._closed = true;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`mcp:${this.name} closed (code=${code})`));
        }
        this.pending.clear();
      });
      this.proc.on("error", (err) => {
        console.error(`[mcp:${this.name}] spawn error:`, err.message);
      });
      // Initialize handshake (MCP 2024-11-05)
      const init = await this._rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "llmTerminal-bridge", version: "1" },
      }, 15000);
      if (init.error) throw new Error(`mcp:${this.name} initialize failed: ${JSON.stringify(init.error)}`);
      // Post-init notification (no response expected)
      this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
    return this._ready;
  }

  _send(obj) {
    if (!this.proc || this._closed) throw new Error(`mcp:${this.name} not running`);
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  _rpc(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp:${this.name} ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: "2.0", id, method, params: params || {} });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  _onData(chunk) {
    this._buf += chunk.toString();
    const lines = this._buf.split("\n");
    this._buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
      // notifications/* and other server-pushed messages — currently ignored
    }
  }

  async listTools() {
    if (this._tools) return this._tools;
    await this.start();
    const r = await this._rpc("tools/list", {});
    if (r.error) throw new Error(`mcp:${this.name} tools/list failed: ${JSON.stringify(r.error)}`);
    this._tools = r.result?.tools || [];
    return this._tools;
  }

  /**
   * Call a tool. Returns the raw MCP `result` (object with `content` array).
   * Caller is responsible for formatting `content` for downstream consumers.
   */
  async callTool(name, args, timeoutMs = 60000) {
    await this.start();
    const r = await this._rpc("tools/call", { name, arguments: args || {} }, timeoutMs);
    if (r.error) {
      // MCP errors propagate as { error: { code, message, data } }; surface a
      // structured tool_result with isError=true so the caller can show it.
      return { content: [{ type: "text", text: `MCP error: ${r.error.message || JSON.stringify(r.error)}` }], isError: true };
    }
    return r.result || { content: [], isError: false };
  }

  stop() {
    if (this.proc && !this._closed) {
      try { this.proc.kill("SIGTERM"); } catch {}
    }
  }
}

module.exports = { MCPClient };

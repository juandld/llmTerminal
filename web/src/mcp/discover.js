"use strict";
const fs = require("fs");
const { MCPClient } = require("./client");

const CLAUDE_CONFIG_PATH = "/home/claude-user/.claude.json";

// Pool keyed by `${projectCwd}::${serverName}` → MCPClient
// Clients are shared across all sessions in the same project — the MCP server
// is a thin protocol bridge and statefulness lives downstream (e.g., the
// chromium browser shared by Playwright's CDP endpoint).
const _pool = new Map();

function _loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, "utf-8"));
  } catch (e) {
    console.warn("[mcp:discover] failed to load .claude.json:", e.message);
    return {};
  }
}

function getMCPServersForProject(projectCwd) {
  const cfg = _loadConfig();
  // The .claude.json schema splits MCPs into TWO tiers:
  //   - top-level mcpServers: global, available in every project (e.g.
  //     llmterminal, crankhero-draft)
  //   - projects[<cwd>].mcpServers: project-specific (e.g. playwright,
  //     which needs a per-project CDP port)
  // Claude itself merges both; our discovery must too, or non-Claude
  // providers only see Playwright and miss the rest of the ecosystem.
  const globalServers = cfg.mcpServers || {};
  const projectServers = cfg.projects?.[projectCwd]?.mcpServers || {};
  // Project entries win over global on name collision.
  return { ...globalServers, ...projectServers };
}

async function getClient(projectCwd, serverName) {
  const key = projectCwd + "::" + serverName;
  let client = _pool.get(key);
  if (client) return client;
  const servers = getMCPServersForProject(projectCwd);
  const cfg = servers[serverName];
  if (!cfg) throw new Error(`No MCP server "${serverName}" configured for project ${projectCwd}`);
  client = new MCPClient({
    command: cfg.command || "/usr/bin/node",
    args: cfg.args || [],
    env: { ...process.env, ...(cfg.env || {}) },
    name: serverName,
  });
  _pool.set(key, client);
  try {
    await client.start();
  } catch (e) {
    _pool.delete(key);
    throw e;
  }
  return client;
}

/**
 * Discover ALL tools for a project across every configured MCP server.
 * Returns: [{ name, description, inputSchema, _server }]
 *   `_server` is added so callers can route tool execution back to the
 *   correct MCP client without a second config lookup.
 */
async function discoverTools(projectCwd) {
  const servers = getMCPServersForProject(projectCwd);
  const out = [];
  for (const serverName of Object.keys(servers)) {
    try {
      const client = await getClient(projectCwd, serverName);
      const tools = await client.listTools();
      for (const t of tools) {
        out.push({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || { type: "object", properties: {} },
          _server: serverName,
        });
      }
    } catch (e) {
      console.warn(`[mcp:discover] ${serverName} failed: ${e.message}`);
    }
  }
  return out;
}

async function callTool(projectCwd, serverName, toolName, args, timeoutMs) {
  const client = await getClient(projectCwd, serverName);
  return await client.callTool(toolName, args, timeoutMs);
}

function stopAll() {
  for (const c of _pool.values()) c.stop();
  _pool.clear();
}

module.exports = { discoverTools, callTool, getMCPServersForProject, getClient, stopAll };

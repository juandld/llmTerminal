// Shared filesystem paths and data dirs for llmTerminal.
// Extracted from server.js (refactor 2026-06-10).
const path = require("path");
const fs = require("fs");

const PROJECTS_DIR = "/home/claude-user/projects";
const DATA_DIR = "/home/claude-user/.llm-terminal";
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const MESSAGES_DIR = path.join(DATA_DIR, "messages");
const CLAUDE_PROJECTS_DIR = "/home/claude-user/.claude/projects";
const MESSAGES_DB_PATH = path.join(DATA_DIR, "messages.db");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MESSAGES_DIR, { recursive: true });

module.exports = { PROJECTS_DIR, DATA_DIR, SESSIONS_FILE, MESSAGES_DIR, CLAUDE_PROJECTS_DIR, MESSAGES_DB_PATH };

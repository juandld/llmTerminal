// Per-session tool-permission store (file-backed Set per session).
// Extracted from server.js (refactor 2026-06-10, phase 7). sessionPermissions
// is exported by reference (callers mutate it in place; never reassigned).
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const PERMISSIONS_DIR = path.join(DATA_DIR, "permissions");
fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });

const sessionPermissions = {}; // sessionId -> Set of permission strings

function loadPermissions(sessionId) {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(PERMISSIONS_DIR, sessionId + ".json"), "utf8"))); }
  catch { return new Set(); }
}
function savePermissions(sessionId) {
  const perms = sessionPermissions[sessionId];
  if (perms) fs.writeFileSync(path.join(PERMISSIONS_DIR, sessionId + ".json"), JSON.stringify([...perms]));
}
function ensurePermissionsLoaded(sessionId) {
  if (!sessionPermissions[sessionId]) sessionPermissions[sessionId] = loadPermissions(sessionId);
}

module.exports = { sessionPermissions, loadPermissions, savePermissions, ensurePermissionsLoaded };

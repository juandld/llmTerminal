"use strict";

/**
 * Translate Claude/MCP tool definitions to provider-specific shapes.
 *
 *   - OpenAI: accepts standard JSONSchema as `parameters`.
 *   - Google (Gemini): does NOT accept $schema, $ref, oneOf, anyOf,
 *     additionalProperties:false; and requires `type` to be a single string
 *     (never an array). Strip / coerce these.
 *
 * Tool names must match /^[a-zA-Z0-9_-]{1,64}$/ for both providers. Most
 * MCP tools already satisfy this; we sanitize any that don't and keep a
 * routing table mapping sanitized → original so callTool() still works.
 */

const TOOL_NAME_OK = /^[a-zA-Z0-9_-]{1,64}$/;

function safeName(name) {
  if (TOOL_NAME_OK.test(name)) return name;
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

// Fields Gemini's schema subset doesn't accept. We strip them recursively
// rather than translating, since the model can still call the tool with valid
// JSON; the schema is only there for hint/validation on the API side.
const _GEMINI_REJECT = new Set([
  "$schema", "$ref", "$defs", "definitions",
  "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
  "oneOf", "anyOf", "allOf", "not",
  "propertyNames", "patternProperties", "dependentSchemas", "dependentRequired", "dependencies",
  "if", "then", "else",
  "const", "contains", "minContains", "maxContains", "prefixItems",
  "examples", "$id", "$comment", "$anchor", "$dynamicAnchor", "$dynamicRef", "$vocabulary",
]);

function _scrubForGoogle(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(_scrubForGoogle);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (_GEMINI_REJECT.has(k)) continue;
    out[k] = _scrubForGoogle(v);
  }
  if (Array.isArray(out.type)) {
    out.type = out.type.find(t => t !== "null") || "string";
  }
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

function toOpenAITools(mcpTools) {
  return mcpTools.map(t => ({
    type: "function",
    function: {
      name: safeName(t.name),
      description: (t.description || "").slice(0, 1024),
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));
}

function toGoogleTools(mcpTools) {
  return [{
    functionDeclarations: mcpTools.map(t => ({
      name: safeName(t.name),
      description: (t.description || "").slice(0, 1024),
      parameters: _scrubForGoogle(t.inputSchema || { type: "object", properties: {} }),
    })),
  }];
}

/**
 * Build a name → { server, originalName } table so a function-call by name
 * can be routed back to the correct MCP server using the un-sanitized name.
 */
function buildRouting(mcpTools) {
  const m = new Map();
  for (const t of mcpTools) {
    m.set(safeName(t.name), { server: t._server, originalName: t.name });
  }
  return m;
}

/**
 * Coerce MCP tool_result content into a single string suitable for the
 * provider's `tool` / `functionResponse` message role. Images become
 * placeholders (the user still sees the real image via the tool_result
 * forwarded to the UI, but the model gets a textual marker).
 */
function flattenToolResult(content) {
  if (!Array.isArray(content)) return String(content || "");
  return content.map(c => {
    if (!c || typeof c !== "object") return String(c);
    if (c.type === "text") return c.text || "";
    if (c.type === "image") return `[image: ${c.mimeType || "image/png"}, ${(c.data || "").length} bytes base64]`;
    if (c.type === "resource") return `[resource: ${c.resource?.uri || ""}]`;
    return JSON.stringify(c);
  }).filter(Boolean).join("\n");
}

module.exports = { toOpenAITools, toGoogleTools, buildRouting, flattenToolResult, safeName };

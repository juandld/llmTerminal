# llmTerminal — Provider-Agnostic Routing (with MCP/Tool Parity)

*Brief — updated 2026-05-28 with full tool-parity spec.*

## Goal

Enable Claude's complete tool ecosystem (native stdlib + MCP servers) on OpenAI and Google models in llmTerminal, with **feature parity**. Selecting `gpt-5.5-pro` or `gemini-3-pro-preview` should behave indistinguishably from selecting `opus` — same `Read`/`Edit`/`Bash`/`Write`/`Glob`/`Grep`/`WebFetch`, same project-scoped MCP servers (Playwright, Gmail, llmt_*, crankhero-draft).

## What exists today

- `server.js:2287` `runClaude()` — spawns `/usr/bin/claude -p --resume <sid>` with full tool ecosystem via the Claude binary.
- `server.js:2430` `runOpenAI()` — fetch + stream `chat/completions`. **Chat-only, no `tools:` field, no MCP.**
- `server.js:2503` `runGoogle()` — fetch + stream `generateContent`. **Chat-only.**
- `server.js:2720` `sendToSession()` — picks runner by `getProvider(session.model)`.
- `~/.claude.json` per-project `mcpServers` config — used by the Claude binary.
- Frontend already renders `tool_use`/`tool_result` events from the WS stream (model-agnostic on the client side).

## Why the gap is real

Each tool ecosystem speaks a different protocol:

| | Native tool spec | MCP server protocol | Tool-call format in chat |
|---|---|---|---|
| Claude | Anthropic SDK | MCP stdio JSON-RPC | `tool_use` content block |
| OpenAI | JSON Schema function spec | (none — proprietary) | `tool_calls` array with deltas |
| Google | JSON Schema function decl | (none) | `functionCall` part |

The current OpenAI/Google paths skip tools entirely because no translation layer exists.

## Architecture

```
                 ┌────────────────────────────────────────────────┐
                 │           sendToSession(prompt)                │
                 └───────────┬────────────────────┬───────────────┘
                             │ provider=claude    │ provider=openai|google
                             ▼                    ▼
                     ┌───────────────┐    ┌────────────────────────┐
                     │  runClaude    │    │   runWithTools         │
                     │  (today)      │    │   (new)                │
                     └───────────────┘    └──────┬─────────────────┘
                                                 │
                          ┌──────────────────────┼──────────────────────┐
                          ▼                      ▼                      ▼
                 ┌────────────────┐  ┌────────────────────┐  ┌───────────────────┐
                 │ Tool discovery │  │ Tool-spec          │  │ Provider          │
                 │ (native + MCP) │  │ translator         │  │ call loop         │
                 └────────┬───────┘  └─────────┬──────────┘  │ (OpenAI / Google) │
                          │                    │             └─────────┬─────────┘
                          ▼                    ▼                       │
                 ┌─────────────────────────────────────────┐            │
                 │       Tool execution adapter             │ ◄──────────┘
                 │  - native stdlib (Read/Edit/Bash/...)    │  tool_call request
                 │  - MCP client (Playwright/Gmail/...)     │
                 │  - bwrap sandbox for Bash + writes       │ ──► tool_result reply
                 └─────────────────────────────────────────┘
```

## Component spec

### 1. Tool discovery

- Read `~/.claude.json` → `projects[<cwd>].mcpServers`.
- For each MCP entry, spawn the server as a child process and call `tools/list` via JSON-RPC over stdio.
- Combine with the native stdlib list (hardcoded): `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `AskUserQuestion`.
- Cache the discovered tool set per-project (TTL ~10min — MCP servers don't change often).
- New module: `web/src/tools/discovery.js`.

### 2. Tool-spec translator

Convert each tool's spec to the active provider's format.

- **Claude/MCP shape:** `{ name, description, input_schema (JSONSchema) }`
- **OpenAI shape:** `{ type: "function", function: { name, description, parameters (JSONSchema) } }`
- **Google shape:** `{ functionDeclarations: [{ name, description, parameters (Schema object — subset of JSONSchema) }] }`

Translators are tiny mappers. Watch for:
- Google's schema doesn't accept `$ref`, `oneOf`, or `additionalProperties: false` — strip/inline these.
- Tool name validity: OpenAI/Google both require `[a-zA-Z0-9_-]{1,64}`. Some MCP tools use `__` separators that are fine; some have dots which need replacing.

New module: `web/src/tools/translate.js`.

### 3. Tool execution adapter

One uniform `executeToolCall(name, args, sessionContext)` returning `{ content, isError }`.

- **Native tools:** Reimplement minimal versions in Node (`fs.readFile`, `fs.writeFile`, etc.). Bash routes through `_bwrapWrap` for the camoHero project; passthrough for others (matches today's behavior).
- **MCP tools:** call the running MCP server (kept alive from discovery) via stdio JSON-RPC `tools/call`.
- All file paths validated against `session.cwd`; deny `..` traversal.
- Result format: same `tool_result` content block shape as Claude emits, so the frontend rendering doesn't need to change.

New modules: `web/src/tools/exec_native.js`, `web/src/tools/exec_mcp.js`, `web/src/tools/mcp_client.js`.

### 4. Provider call loops

**OpenAI loop** (`runWithTools(provider="openai", ...)`):

```
loop:
  POST /v1/chat/completions { messages, tools, stream: true }
  read SSE stream:
    accumulate text deltas → emit `assistant text` to WS
    accumulate tool_call deltas → on completion of a tool_call:
      emit `tool_use` to WS  
      result = await executeToolCall(name, args)
      append { role: "assistant", tool_calls: [...] } to messages
      append { role: "tool", tool_call_id, content } to messages
  if last response had no tool_calls → break
```

**Google loop** is the same shape with different field names. Gemini's tool-calling streams `functionCall` parts mid-content; need a buffer that accumulates until a part completes.

Both loops: respect AbortController on session disconnect; emit a final `result` event with usage/duration.

### 5. Session-state isolation

- Claude resumes via `--resume <claudeSessionId>`; the binary reads `.claude/projects/.../<sid>.jsonl`. **Free.**
- OpenAI/Google have no server-side session state. The full `messages` array must be replayed on every API call within the loop AND across user turns.
- `buildHistory()` (server.js:2380) today **skips** `tool_activity`/`tool_result`. For tool-using providers it must include them so the model can see what it already did.
- Token-budget pressure: with full tool history, sessions get expensive. Implement a sliding window (last N tool exchanges + sticky user/assistant text turns).

### 6. UI integration

- Already shipped: client renders `tool_use`/`tool_result` events.
- Add: a per-session "tools enabled" indicator (small icon next to the model trigger) that's lit for any provider once tool discovery completes.
- Surface MCP server health (which servers are connected) in the topbar drawer.

## Hard problems

1. **MCP server lifecycle.** Today claude spawns + tears down MCP servers per-session. For the bridge:
   - Option A: spawn MCP servers per llmTerminal session (mirrors Claude). Expensive at scale but simplest.
   - Option B: one long-lived MCP-server pool per project, shared across sessions. Faster, but needs per-session permission/auth scoping.
   - **Recommend A for v1**, B if it becomes a bottleneck.

2. **Permission gating.** Claude has `--dangerously-skip-permissions`. For the bridge we need an equivalent — either trust the model (current behavior with `--dangerously-skip-permissions`) or implement an interactive approval flow. Match Claude's behavior for parity.

3. **Streaming tool-call accumulation.** Both OpenAI and Google stream tool calls as fragments (`tool_calls[0].function.arguments` arrives in pieces). The accumulator state machine is non-trivial — partial JSON, parallel tool calls, error recovery. Test thoroughly.

4. **Cost/latency.** Replaying full conversation history with tools every turn is way more expensive than Claude's local-resume. Consider:
   - Sliding-window history (last 20 turns by default; configurable).
   - Surfacing per-message token cost in the UI so the user can see when they're paying for replay.

5. **AskUserQuestion.** This tool is special — it doesn't execute on the host; it surfaces UI back to the user and waits for a response. Need to plumb the question through WS → user picks → resume the loop with the answer as `tool_result`.

## Phased rollout

| Phase | Scope | Effort | Done = |
|---|---|---|---|
| **P1** | Native stdlib tools (Read/Edit/Write/MultiEdit/Bash/Glob/Grep) on OpenAI gpt-* and o-models | 1-2 days | gpt-5.5-pro can edit a file via Edit, run a Bash command, grep the result |
| **P2** | Same native stdlib on Google Gemini | 1 day | gemini-3-pro can do the same |
| **P3** | MCP bridge (Playwright, Gmail, llmt_*, crankhero-draft) on both providers | 2-3 days | gpt-5.5-pro can take a Playwright screenshot, gemini-3-pro can draft an email |
| **P4** | UI polish: MCP health indicator, per-message cost, sliding-window history | 1 day | The picker shows tool-enabled state; long sessions don't run unbounded cost |

## Definition of done (P3 acceptance)

1. Pick `gpt-5.5-pro` from the picker.
2. Say: *"Open my browser to https://crankwheel.com and take a full-page screenshot."*
3. Model calls `browser_navigate` (MCP) → `browser_take_screenshot` (MCP). Screenshot appears in the preview drawer.
4. Say: *"Edit `/home/claude-user/projects/llmTerminal/web/server.js` to change the port from 7683 to 7684 — then revert."*
5. Model calls `Edit` (native) twice. Diff visible in preview drawer.
6. No banner saying "chat only." Experience is identical to Claude opus.

## Stopgap until P1 lands

Implemented 2026-05-28 (this session):

- Model picker trigger button shows a **"chat only"** badge when the active provider is OpenAI or Google.
- One-line hint above the input field: *"<provider>: tools disabled — chat only. Switch to Claude for filesystem/browser/email actions."*
- Closing the gap so a user picking `gpt-5.5-pro` doesn't think "why didn't it use the browser" — same answer to the same complaint.

## Where to start (for the next session)

1. Read this brief end-to-end.
2. Scaffold `web/src/tools/` with empty `discovery.js`, `translate.js`, `exec_native.js`, `exec_mcp.js`, `mcp_client.js`.
3. P1: implement `exec_native.js` for `Read`/`Write`/`Bash`. Hook into a stub `runWithTools` for OpenAI only. Smoke-test: send "list files in /home/claude-user/projects" with gpt-4.1 and confirm Bash gets called.
4. From there, expand outward through the phases.

# llmTerminal WebSocket protocol

Connection: `wss://hero.camofiles.app/terminal/ws` (proxied through nginx to `:7683/ws`).
Each connection is tied to a session ID via the URL hash on the chat page (`/terminal/#<sessionId>`).

All messages are JSON. `type` is the discriminator.

---

## Client → Server

| Type | Payload | When |
|---|---|---|
| `prompt` | `{ client_id, text, images[], resend? }` | User sends a chat message. `client_id` lets server ack and dedupe resends. `images` is array of `{ data: <base64>, mimeType }`. |
| `interrupt` | `{}` | User taps Stop. Server kills the active claude process group, replies with `interrupted`. |
| `set_model` | `{ model }` | User picks a model in the topbar dropdown. |
| `permission_grant` | `{ permission, autoRetry? }` | User grants a permission requested via `permission_denied`. If `autoRetry !== false`, server re-runs the last prompt with the new permission. |
| `load_more` | `{ before, count }` | Lazy-load older history. `before` is the message offset to fetch backwards from. |
| `pong` | `{ ts }` | Reply to server ping (keepalive). |
| `get_summary` | `{}` | Request session summary card. |

## Server → Client

### Lifecycle / connection
| Type | Payload | Meaning |
|---|---|---|
| `session` | `{ session }` | Sent on connect. Full session object. |
| `history` | `{ messages[], total, offset }` | Initial slice of recent messages on connect. |
| `history_prepend` | `{ messages[], offset, total }` | Reply to `load_more`. |
| `permissions_state` | `{ permissions[] }` | Currently granted permissions for this session. |
| `status` | `{ status }` | "connected" right after session payload. |
| `ready` | `{}` | All initial sync payloads have been sent; client can start posting. |
| `ping` | `{ ts }` | Server keepalive every 20s; client replies with `pong`. |

### Run lifecycle (per `prompt`)
| Type | Payload | Meaning |
|---|---|---|
| `ack` | `{ client_id }` | Server received the prompt; safe to drop from outbox. |
| `thinking` | `{}` | Claude has been spawned for this prompt; UI shows thinking indicator. |
| `text` | `{ text }` | An assistant text block streamed in. |
| `tool_use` | `{ name, input }` | Agent is about to call a tool. |
| `tool_result` | `{ name, content }` | Tool result came back. Mostly informational (UI doesn't render most). |
| `permission_denied` | `{ tool_name, tool_input, tool_use_id, message }` | A tool call needs permission. UI shows a card; user grants via `permission_grant`. |
| `permission_granted` | `{ permission }` | Confirms a `permission_grant` succeeded. |
| `email_draft` | `{ to, cc, subject, body, thread_id, attachments[], project, ts }` | The `mcp__crankhero-draft__draft_email` tool produced a structured payload. UI renders the email-draft action card. |
| `done` | `{}` | Claude run finished cleanly. UI clears busy state. |
| `idle` | `{}` | Same effect as `done` but signals the agent decided to stop without a final message. |
| `error` | `{ message }` | Run error (e.g. "Still processing previous message"). |
| `api_error` | `{ message }` | Upstream Anthropic API error. |
| `exit` | `{ code }` | Claude process exit code != 0. |
| `interrupted` | `{}` | Reply to client `interrupt`. UI clears busy state, shows "Stopped." note. |

### Other
| Type | Payload | Meaning |
|---|---|---|
| `model_set` | `{ model }` | Confirms `set_model`. |
| `title_updated` | `{ sessionId, title }` | Background title-gen finished. Sidebar refreshes title. |
| `session_summary` | `{ summary }` | Reply to `get_summary`. |

---

## HTTP routes

| Route | Method | Returns | Notes |
|---|---|---|---|
| `/health` | GET | `{ok:true}` | Liveness. |
| `/api/projects` | GET | `[{name, path, ...}]` | Discovered project dirs. |
| `/api/sessions` | GET | `[{id, project, title, lastActive, messageCount}]` | All sessions. |
| `/api/sessions/:id` | DELETE | `{ok}` | Removes a session + its messages. |
| `/api/email-draft/send` | POST | `{ok, message_id, account, output} \| {ok:false, error, stdout, stderr}` | Action card "Send" button. Shells out to `camoHero/scripts/send_gmail_email.py`. camoHero session only. |
| `/api/email-draft/log-intent` | POST | `{ok}` | Logs "Open in Gmail" / "mailto" intent into `gmail_sent_log.jsonl` for dedup. |
| `/api/browser-status` | GET (`?project=<name>`) | `{running, tabs, url, title, activity, idleSec}` | Per-project Chromium status. `activity ∈ {navigating, active, idle, dormant, off}`. |
| `/api/file` | GET (`?path=<abs>`) | file body | Serves files under `/home/claude-user/projects/camoHero/` or `/.llm-terminal/uploads/`. Strict allowlist; rejects path traversal. |
| `/api/previews` | various | (proxied to narrativeHero `:8000`) | File preview drawer + modal. |
| `/tts` | POST `{text, voice?}` | audio bytes | ElevenLabs TTS proxy. |


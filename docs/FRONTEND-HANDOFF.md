# AgentOne Frontend Handoff

A single, complete reference for a team building the production React
frontend that will replace the current temporary HTML+JS UI.

The current frontend lives at [`src/frontend/`](../src/frontend/) and is
served as static files by Fastify. It is intentionally minimal — its job
was to validate the server's event/REST contract end-to-end, not to be
the long-lived UI.

This document is the entire contract. If something is in the codebase
but not in this doc, treat the doc as the source of truth and ask before
relying on it.

---

## System overview

AgentOne is a single-user, local-first agent runtime:

- **Server**: Node.js + Fastify. Hosts the LLM-facing orchestrator, the
  persistence layer (SQLite + filesystem), and the REST/WebSocket
  surface the UI talks to.
- **Local model**: LM Studio over `http://localhost:1234/v1`. The
  conversation model and embedding model are both local by default.
- **Expert escalation**: OpenRouter for stronger models (Claude Sonnet,
  GPT-class, Deepseek). Gated by per-call and per-session USD budgets
  declared in agent profiles.
- **Memory**: a Karpathy-style wiki (markdown on SharePoint/OneDrive),
  cross-session conversation history with FTS5 + vector search, and
  document indexing over project files (PDFs, DOCX, XLSX).

The frontend's job: render a chat UI, stream model output as it
arrives, surface tool calls and meta events to the user, let the user
manage sessions and the wiki, and provide visibility into auto-running
background processes (passive recall, auto-distill, expert spend,
cancellation).

**There is no auth.** The server binds to `127.0.0.1` by default; if
`HOST=0.0.0.0` is set, anyone on the LAN can use it. The frontend should
not implement its own login layer.

---

## Architecture pattern

The server is the single source of truth. The frontend is a view layer.

- **REST for actions**: create a session, send a message, run a command,
  cancel a turn, rename a session. Idempotent reads use GET; mutations
  use POST/PATCH.
- **WebSocket for events**: every interesting thing that happens on the
  server emits an `AgentEvent` on a global bus. The frontend subscribes
  per-session and renders events as they arrive.
- **No client-side polling.** If you find yourself writing `setInterval`,
  the server should be emitting an event instead — open an issue.

The current temporary frontend uses a single WebSocket per page and
session subscriptions are toggled via query-string at handshake or
JSON messages after open. The React rewrite should preserve this
pattern.

---

## REST API

All requests are JSON. Errors return non-2xx with `{ error, details? }`.

### `GET /api/health`

Server readiness + boot configuration. Call this on app load.

```json
{
  "status": "ok",
  "model": "local-fast",
  "contextWindow": 32768,
  "storageRoot": "C:\\Users\\...\\OneDrive\\...",
  "wikiPrefix": "wiki",
  "agentProfile": "researcher"
}
```

Use `agentProfile` as the value for new-session creation so the stored
profile matches the server's actual orchestrator. Don't hardcode
profile names.

### `GET /api/sessions`

```json
{ "sessions": [ { "id": "...", "title": null | "...", "agentProfile": "...", "createdAt": 1234567890 }, ... ] }
```

Sessions are ordered newest-first by `createdAt`.

### `POST /api/sessions`

Body: `{ "agentProfile"?: string, "title"?: string }`. The session id is
returned for subscription. `agentProfile` is optional — when omitted, the
session inherits the server's boot profile (see `GET /api/health`).

**Path A single-profile-per-server.** This server boots with one profile
(env `AGENT_PROFILE`). If you POST an `agentProfile` that doesn't match,
the server returns `409 Conflict`:

```json
{ "error": "PROFILE_MISMATCH", "message": "Server is running agent profile \"_base\" — cannot create a session under \"researcher\". Restart with AGENT_PROFILE=researcher, or omit agentProfile to use the boot profile." }
```

The same 409 surfaces from `POST /api/sessions/:id/messages` and
`POST /api/sessions/:id/command` when an existing session's persisted
profile doesn't match the boot profile (e.g. resuming a session
created under a different `AGENT_PROFILE`).

```json
{ "session": { "id": "...", "title": null, "agentProfile": "...", "createdAt": ... } }
```

### `PATCH /api/sessions/:id`

Rename. Body: `{ "title": string }`. Title is 1-200 chars.

```json
{ "session": { ...updated } }
```

Also emits `session.titled` so other open clients update.

### `POST /api/sessions/:id/messages`

Body: `{ "text": string }` (min 1 char). Returns immediately —
streamed output arrives via the WebSocket. The server's response is
just `{ "ok": true }` once the message is accepted.

### `POST /api/sessions/:id/cancel`

Cancel an in-flight turn. Returns:

```json
{ "outcome": "cancelled" | "no_active_turn" | "unknown_session" }
```

The cancellation propagates as `turn.cancel_requested` then
`turn.cancelled` (kind: 'soft' | 'hard') events on the WS.

### `GET /api/profiles`

Lists every agent profile under `profiles/agents/*.yaml`. Each entry is
loaded through the real resolver, so the picker sees what the
orchestrator would actually use. Broken profiles are surfaced with
`ok: false` rather than dropped — render them with a warning.

```json
{
  "profiles": [
    {
      "id": "_base",
      "description": null,
      "defaultModel": "local-fast",
      "defaultSkills": ["system/filesystem", "system/memory"],
      "ok": true
    },
    {
      "id": "researcher",
      "description": "Local conversation with expert escalation",
      "defaultModel": "local-fast",
      "defaultSkills": ["system/filesystem", "system/web", "experts/consult"],
      "ok": true
    },
    {
      "id": "broken",
      "description": null,
      "defaultModel": "",
      "defaultSkills": [],
      "ok": false,
      "error": "INVALID: ..."
    }
  ],
  "current": "researcher"
}
```

`current` is the profile the server is booted with — show it as the
default selection. Switching profiles requires a server restart with
`AGENT_PROFILE` set; the UI can't change it on the fly today.

### `POST /api/profiles`

Create a new agent profile. Body is the YAML-equivalent JSON shape
parsed by [`AgentProfileSchema`](../src/profiles/agent-profile.ts);
`id` lives in the body (not the URL) for create.

```jsonc
// Request
{
  "id": "ops",                          // required; /^[a-z0-9_-]+$/, must be unique
  "description": "Operational tasks",   // optional
  "extends": "_base",                   // optional; must reference an existing profile
  "default_model": "local-fast",        // required unless inherited via extends
  "default_skills": ["system/filesystem"],
  "permissions": {                      // optional; defaults applied per schema
    "skills": { "allow": [], "deny": [] },
    "experts": { "allow": ["openrouter/sonnet"], "budget_per_call_usd": 0.50 }
  },
  "deny_tools": [],
  "passive_recall": { "enabled": false },
  "auto_distill":  { "enabled": false }
}

// Response 201 — the freshly resolved profile (same row shape as GET /api/profiles)
{
  "id": "ops",
  "description": "Operational tasks",
  "defaultModel": "local-fast",
  "defaultSkills": ["system/filesystem"],
  "ok": true
}
```

**Errors:**
- `400` — body fails `AgentProfileSchema` validation. Response: `{ error: 'INVALID', details: Array<{ path: string[], message: string }> }`. The frontend maps `path` directly to `react-hook-form` field names (joined with `.`).
- `409` — a profile with this `id` already exists, OR the chosen `extends` target doesn't exist.

Server writes the validated body to `profiles/agents/<id>.yaml`. Comments and key ordering are not preserved across edits — the YAML is now a UI-managed artifact, not a hand-edited file.

### `PATCH /api/profiles/:id`

Edit an existing profile in place. Body is a partial update: any keys present overwrite; omitted keys keep their stored value. `id` cannot be changed (rename = delete + create).

```jsonc
// Request (partial)
{
  "description": "Updated description",
  "permissions": {
    "experts": { "budget_per_session_usd": 5.00 }
  }
}

// Response 200 — the freshly resolved profile after edit
```

**Errors:**
- `400` — merged result fails validation. Same `details` shape as POST.
- `404` — no profile with this id.

Editing the **active boot profile** succeeds and writes the YAML, but the running orchestrator continues to use the in-memory resolved copy from boot. The frontend's Profiles tab shows a persistent "Changes apply on next restart" banner for the active profile per ADR-0006.

### `DELETE /api/profiles/:id`

Delete a profile.

```jsonc
// Response 200 — { ok: true } on successful delete
// Response 409 — profile is the active boot profile
{ "error": "ACTIVE_BOOT_PROFILE", "details": { "id": "researcher" } }

// Response 409 — non-archived sessions reference this profile
{ "error": "PROFILE_IN_USE", "details": { "id": "ops", "affectedSessions": 3 } }

// Response 409 — profile is `_base` (reserved)
{ "error": "RESERVED_PROFILE", "details": { "id": "_base" } }

// Response 404 — no profile with this id
```

The server lists "affected sessions" by counting rows in `sessions` where `agentProfile = :id AND archived = false`. Archived sessions don't block delete — they're read-only and the `PROFILE_MISMATCH 409` guard already prevents reopening them under the wrong profile after restart.

Deleting a profile that other profiles `extends` does **not** auto-cascade — the dependent profiles will start failing to resolve on next read, and `GET /api/profiles` will surface them with `ok: false`. The frontend surfaces this with an `extends` field warning, but the server does not refuse the delete (operator may be intentionally removing the chain).

### `GET /api/drafts`

Lists every distilled-notes draft under `wiki/drafts/`. Sorted
newest-mtime first. Use this to render a review queue for the user.

```json
{
  "drafts": [
    {
      "path": "drafts/distilled-sess-abc-2026-05-22.md",
      "sessionId": "sess-abc",
      "generatedAt": "2026-05-22T00:00:00.000Z",
      "title": "distilled-sess-abc",
      "noteCount": 3,
      "mtime": "2026-05-22T00:00:01.123Z",
      "bytes": 1234
    },
    ...
  ]
}
```

To render full draft content, use `wiki_read` via the agent (the UI
doesn't have direct file-reading endpoints yet — that would be a future
addition).

### `GET /api/commands`

Lists every available slash command — both system commands and skill
slash commands.

```json
{
  "commands": [
    { "name": "help", "description": "...", "usage": "/help", "requiresSession": false, "source": "system" },
    { "name": "deep-dive", "description": "...", "usage": "/deep-dive [text]", "requiresSession": true, "source": "skill", "skill": "experts/consult" },
    ...
  ]
}
```

Use this to power slash-autocomplete.

### `POST /api/sessions/:id/command`

Run a command in a session. Body: `{ "name": string, "args"?: object, "text"?: string }`.

```json
{ "result": CommandResult }
```

Where `CommandResult` is a discriminated union — see "Command results"
below.

### `POST /api/command`

Run a session-agnostic command. Body: `{ "name", "args"?, "text"?, "sessionId"? }`.

Used for commands that work without a session (e.g. `/sessions`,
`/help`, `/new`).

---

## WebSocket: `/ws`

Connect to `ws://<host>:<port>/ws?sessionId=<id>` to subscribe at
handshake. The query string is repeatable for multi-session subscribe.

Mid-connection subscribe/unsubscribe via JSON messages:

```json
{ "op": "subscribe", "sessionId": "..." }
{ "op": "unsubscribe", "sessionId": "..." }
```

Both are idempotent. The server filters events by session, but a few
are global (no sessionId) — see below.

### Event types

Every event has `{ type, ts }` and either a `sessionId` or
`sessionId: null` for global events. The complete enumeration:

#### Session lifecycle

- **`session.created`** `{ sessionId, agentProfile, ts }` — fires when a
  new session is created.
- **`session.titled`** `{ sessionId, title, ts }` — fires when either
  the AutoTitler or a manual PATCH sets a session title.

#### Message stream

- **`message.user.received`** `{ sessionId, turnId, ts }` — fires when
  a user message is persisted, before the assistant turn starts.
- **`message.assistant.started`** `{ sessionId, turnId, ts }` — fires
  at the start of each *iteration* of the tool loop. A single user
  message can produce multiple assistant turns if tool calls intervene.
- **`message.assistant.delta`** `{ sessionId, turnId, delta }` —
  streaming token deltas. Concatenate to build the assistant message in
  real time. Transient (not persisted in the event log).
- **`message.assistant.completed`** `{ sessionId, turnId, inputTokens, outputTokens, ts }` —
  fires once per *user message*, at the end of the whole tool loop (not
  per iteration). Use this to know the assistant has fully finished.

#### Tool calls

- **`tool.called`** `{ sessionId, turnId, toolCallId, tool, args, ts }` —
  fires when the agent invokes a tool. `args` is parsed JSON, not a raw
  string.
- **`tool.completed`** `{ sessionId, turnId, toolCallId, tool, ok, durationMs, ts }` —
  fires when a tool returns successfully.
- **`tool.failed`** `{ sessionId, turnId, toolCallId, tool, code, message, ts }` —
  fires when a tool returns a structured error. `code` is one of the
  stable error codes: `TOOL_VALIDATION`, `TOOL_RUNTIME`, `TOOL_TIMEOUT`,
  `PERMISSION_DENIED`, `RESOURCE_UNAVAILABLE`, `BUDGET_EXCEEDED`,
  `RATE_LIMITED`, `SKILL_LOAD_FAILED`.
- **`tool.hook_denied`** `{ sessionId, tool, hook, reason, ts }` —
  fires when a pre-hook (e.g. profile `deny_tools`) blocks a tool
  call. Pair with the `tool.failed` event that follows.
- **`tool.hook_mocked`** `{ sessionId, tool, hook, ts }` — fires when
  a pre-hook intercepted a tool call with a mocked result.
- **`tool.result_truncated`** `{ sessionId, toolCallId, tokensBefore, tokensAfter, ts }` —
  fires when the 60% rule has trimmed a tool result. The agent can
  rehydrate via `read_turn(id="<toolCallId>")`.

#### Cancellation

- **`turn.cancel_requested`** `{ sessionId, ts }` — fires when
  `cancelSession` is called.
- **`turn.cancelled`** `{ sessionId, kind, ts }` — fires when the loop
  observes the cancel. `kind: 'soft'` = caught at an iteration boundary,
  `kind: 'hard'` = caught mid-stream (provider torn down).

#### Skills

- **`skill.loading`** `{ sessionId, name, ts }` — agent called
  `load_skill`.
- **`skill.loaded`** `{ sessionId, name, toolsRegistered, ts }` —
  successful load with the tools that became available.
- **`skill.load_failed`** `{ sessionId, name, reason, ts }` — load
  refused (permission, file missing, syntax).

#### Context management

- **`context.compressing`** `{ sessionId, tokensBefore, ts }` —
  compression started.
- **`context.compressed`** `{ sessionId, tokensBefore, tokensAfter, turnsCompressed, ts }` —
  compression completed.
- **`context.compression_failed`** `{ sessionId, reason, ts }` —
  compressor model failed; system falls back to truncation.
- **`context.truncated`** `{ sessionId, turnId, bytesBefore, bytesAfter, ts }` —
  legacy per-turn truncation (rarely fires; PRD #45 replaced this with
  the per-message rule).

#### Memory

- **`recall.injected`** `{ sessionId, sources: [{ kind, ref, title }], ts }` —
  passive recall surfaced N sources at the start of this user turn.
  Render as a meta line; the agent has already seen them.
- **`session.auto_distilled`** `{ sessionId, notesCount, draftPath, ts }` —
  the auto-distill scheduler wrote a draft page.
- **`session.auto_distill_skipped`** `{ sessionId, reason, ts }` —
  scan ran but didn't distill. Reasons:
  `no_turns | too_short | no_notes | parse_failure | already_distilled | provider_error`.

#### Expert spend

- **`expert.consulted`** `{ sessionId, expert, model, inputTokens, outputTokens, costUsd, sessionSpendUsd, latencyMs, ts }` —
  a `consult_expert` call landed; surface cost + latency in the stream.
- **`expert.budget_exceeded`** `{ sessionId, expert, costUsd, perCallBudgetUsd, ts }` —
  budget gate denied the call.

#### Indexing (global; `sessionId: null`)

- **`embedding.indexed`** `{ sessionId: null, turnsIndexed, ts }` —
  background indexer drained N turns.
- **`embedding.failed`** `{ sessionId: null, reason, ts }` — indexer hit
  a provider error.

---

## Command results

`POST /api/.../command` returns `{ result }` where `result` is a
discriminated union:

```ts
type CommandResult =
  | { kind: 'text'; content: string }
  | { kind: 'session_list'; sessions: SessionSummary[] }
  | { kind: 'session_switch'; session: Session; reason: 'new' | 'switched' }
  | { kind: 'session_cleared'; sessionId: string; turnsDeleted: number }
  | { kind: 'skill_loaded'; skill: string; toolsRegistered: string[]; alreadyLoaded: boolean }
  | { kind: 'context_compacted'; sessionId: string; tokensBefore: number; tokensAfter: number; changed: boolean }
  | { kind: 'skill_invoked'; skill: string; forwarded: boolean; alreadyLoaded: boolean }
  | { kind: 'error'; message: string; recoverable: boolean }
```

Render each `kind` distinctly: text in a meta-styled block, session
lists as clickable rows, errors with a red badge, etc.

---

## Slash commands

User typed `/foo bar=1 hello world` should:

1. Split off the command name (`foo`).
2. Parse `key=value` tokens into the `args` object.
3. The remaining text becomes `text`.
4. If the command's `source: 'skill'`, POST `/api/sessions/:id/command`
   with `{ name, args, text }`. The server will load the skill if
   needed and forward `text` as a user message.

The current implementation lives in `src/frontend/slash-parser.js` —
the parser is the same regardless of UI tech. Reuse the file or rewrite
in TypeScript; either way the contract is stable.

Reserved system command names (will not collide with skill commands):
`new`, `help`, `load`, `compact`, `sessions`, `clear`, `cost`,
`distill`.

---

## Tool-call rendering

Tool calls land as `tool.called` events between assistant deltas. The
recommended pattern:

1. While streaming, render assistant deltas inline.
2. When `tool.called` arrives, render a compact chip with the tool name
   + a short args preview.
3. When `tool.completed` arrives, update the chip with a duration.
4. When `tool.failed` arrives, mark the chip red + show the error code.
5. After `message.assistant.completed`, the turn is fully done; finalize
   any in-progress UI state.

The current UI uses `<span class="tool-chip">` per call. The React
rewrite can replace these with a `<ToolChip />` component.

---

## Feature checklist for the React rewrite

Minimum viable (parity with current UI):

- [ ] Sessions list (sidebar) with create + switch
- [ ] Streamed message log with assistant deltas
- [ ] Tool chips for in-flight + completed + failed calls
- [ ] Slash command bar (input parses `/cmd ...`)
- [ ] Meta event lines: passive recall, auto-distill, expert spend,
      compression, tool truncation
- [ ] Reconnect with capped exponential backoff (1s → 30s, escalation
      every 5 retries). Logic lives in
      [`src/frontend/ws-backoff.js`](../src/frontend/ws-backoff.js) —
      reuse the pure function

Beyond current parity:

- [ ] Slash command autocomplete (drop-down on `/`)
- [ ] Profile picker on new-session — call `GET /api/profiles`,
      default-select `current`, show `ok: false` entries with a warning
      icon
- [ ] Session rename UI
- [ ] **Cancel button** for in-flight turns (`POST /api/sessions/:id/cancel`)
- [ ] **Drafts review surface** — list via `GET /api/drafts`, preview
      content via `wiki_read` (through the agent), "promote to
      canonical" action via `wiki_write` (also through the agent for
      now)
- [ ] **Settings inspector** — show the active profile's
      passive_recall, auto_distill, deny_tools, expert budgets. Read
      via `GET /api/health` for now + extend if needed
- [ ] Per-call cost surfacing — `expert.consulted` events carry
      `costUsd` and `sessionSpendUsd`
- [ ] Markdown rendering for assistant messages (currently raw text)

---

## Extensibility points

The server's event union is the contract. Each new event type:

- Adds a case to `src/core/events.ts`
- Server emits via `bus.emit({ type, ... })`
- Frontend gains a `case 'event.type':` in its handler

To keep the React UI flexible, build event handling as a switch that
falls through gracefully on unknown types (log + drop) rather than
exhaustive matching that breaks when the server adds an event.

Command results have a similar shape — extend `CommandResult` on the
server, add a renderer on the client, fall back to a generic display
for unknown kinds.

---

## Auth model

There is none. AgentOne is single-user, local-first.

- Default bind: `127.0.0.1` — only this machine
- LAN bind: `HOST=0.0.0.0` — anyone on the LAN
- Internet: not supported. If you need it, put a reverse proxy with
  auth in front

The frontend should not implement login. If a UI element exists to
"switch user," it doesn't map to anything on the server.

---

## Migration plan

The current frontend stays put. The React build coexists by being
served from a different directory.

1. Build the React app to a `dist/` (or wherever your bundler emits)
2. Run the server with `FRONTEND_DIR=./dist` (or wherever)
3. Fastify's static handler now serves the React build at `/`
4. The WebSocket and REST endpoints are unchanged

To switch back to the temporary UI: `FRONTEND_DIR=./src/frontend`.

There's no flag day. Both UIs can be running on different ports
during the transition if you set them up that way.

### Things NOT to depend on in the temporary UI

- The CSS is inline and minimal — don't copy it
- `client.js` is a single 500-line file — don't model your component
  tree on it
- The slash parser (`slash-parser.js`) and WS backoff
  (`ws-backoff.js`) ARE worth reusing — they're pure logic with unit
  tests at `tests/slash-parser.test.ts` and `tests/ws-backoff.test.ts`

---

## Open questions for the frontend team

The shell architecture and platform stack are now decided. See
[`./adr/0006-frontend-shell-architecture.md`](./adr/0006-frontend-shell-architecture.md)
for the full record:

- **Bundler**: Vite + React 19 SPA. Build emits to `dist/`; serve via `FRONTEND_DIR=./dist`.
- **State management**: TanStack Query for REST; Zustand (per-session slices) for WS-driven state.
- **Markdown**: `react-markdown` + `remark-gfm` + `rehype-highlight`.
- **Component library**: shadcn/ui on Tailwind, lucide-react icons, react-hook-form + zod for forms.
- **Shell**: top bar (theme + notifications bell) + left sidebar (Chat, modules, Drafts, Skills, Settings, then session list) + main pane (chat centred, modules fill).
- **Cross-page awareness**: notification tray (right-edge Sheet, manual open) renders `request_user_input` questions with inline option buttons; no auto-route, no modal.

### Server-side work this adds

The full-editor scope for agent profiles extends the v1 contract with:

- `POST /api/profiles` — create
- `PATCH /api/profiles/:id` — edit
- `DELETE /api/profiles/:id` — delete (refuses active boot profile; refuses if non-archived sessions reference it)

The active boot profile retains the restart constraint; the editor surfaces a "Changes apply on next restart" banner rather than implying live reload.

The orchestrator's `notification.created` events for `request_user_input` must put `{ question, options? }` into `payload_json` in a shape the frontend can render directly.

### Phase 1.5 punch list

The full Phase 1.5 build — every shell surface, the Chat parity rewrite, the Settings → Profiles editor, the Skills catalog, the notification tray, and the five shared module components — is broken into trackable items in [`./planning/phase-1.5-react-punchlist.md`](./planning/phase-1.5-react-punchlist.md). Start there for the work breakdown; this doc remains the API/contract reference.

---

## Glossary

For terms used throughout this doc:

- **Session**: one conversation thread. Persisted indefinitely.
- **Turn**: one message in a session (user or assistant or tool).
- **Tool call**: an LLM-issued function invocation, modeled as a pair
  of user-visible events (`tool.called` + `tool.completed`).
- **Skill**: a folder under `skills/` with markdown + optional tool
  handlers. Loaded on demand by the agent.
- **Profile**: a YAML file that defines an agent's default skills,
  permissions, budgets, and memory config.
- **Provider**: an LLM API client (LM Studio, OpenRouter).
- **Wiki**: agent-authored markdown notes under `wiki/` in the storage
  root. Has its own FTS5 index.
- **Drafts**: agent-generated unreviewed content under `wiki/drafts/`,
  primarily from `/distill` and the auto-distill scheduler.
- **Passive recall**: automatic wiki + history lookup at the start of
  each user turn, with results injected as a system message.

For the complete domain language, see
[`../CONTEXT.md`](../CONTEXT.md) and the PRD at
[`./PRD.md`](./PRD.md).

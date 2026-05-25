# AgentOne

A local, single-user, event-driven agent runtime with persistent memory — paired with a desk-side operations app for a design/drafting practice (email triage, project management, scope + proposals, invoicing + QBO sync).

AgentOne pairs a small architectural core (memory + provider tier + skill discovery + module registry) with two filesystem-based extension primitives — **Skills** (drop a folder, get a tool) and **Modules** (drop a folder, get a schema-owning service with its own routes and Skills). Local LM Studio models do the everyday work; OpenRouter experts (Opus, GPT-5.5, Deepseek) are reachable as a tool when a problem genuinely needs them.

See [CONTEXT.md](CONTEXT.md) for the domain language and [docs/PRD.md](docs/PRD.md) for the full product spec. The V2 build plan lives in [docs/planning/v2-business-flow.md](docs/planning/v2-business-flow.md).

---

## What it is

### Core agent runtime

- **Karpathy-style wiki** — agent-authored markdown notes that survive across sessions, queryable by path, search, and backlinks.
- **Conversation history** — every turn persisted in SQLite, indexed with FTS5 + local embeddings, recallable across sessions.
- **Project documents** — stakeholder PDFs / Office files / CAD live under `projects/`, readable via the `system/documents` skill with pagination and per-format extraction.
- **Skill system** — drop a folder under `skills/` (or `modules/<m>/skills/`), optionally bundle TypeScript handlers, and the loader discovers it on next start. Pure-prose skills (just `SKILL.md`) are first-class. See [ADR 0001](docs/adr/0001-skill-system-as-primary-extensibility.md).
- **Module system** — drop a folder under `modules/`, ship `MODULE.md` + `schema/*.sql` + a `createService` factory, and the boot pass discovers it, applies migrations, and exposes the service through a `ModuleRegistry`. See [ADR 0004](docs/adr/0004-modules-as-second-extensibility-primitive.md).
- **Two-tier providers** — LM Studio by default; OpenRouter via the `consult_expert` core tool, with per-call and per-session budgets.
- **Agent + Model Profiles** — YAML configs with single-level inheritance from `_base`. Agent profiles reference *roles* (general / compressor / embedding / expert), not model IDs, so swapping models doesn't touch profiles.
- **Event bus** — every meaningful action emits an event; the React UI streams them and hooks can subscribe (see [ADR 0003](docs/adr/0003-event-bus-is-observational.md)). Distinct from the immutable [audit log](docs/planning/v2-business-flow.md#audit-log) that Module mutations always write.
- **Spawned sessions + notifications** — Modules and HTTP routes can spawn a session with a seed message, and the agent can pause for input via `request_user_input`; both surface through a notification tray. See [ADR 0005](docs/adr/0005-non-chat-session-activation.md).
- **Context management** — synchronous compression at 80% of the window, oversized tool results truncated head+tail at 60%.
- **Auth gate** — `/api/*` and `/ws` require a bearer token persisted to `<STORAGE_ROOT>/.auth/token`. Auto-generated on first boot and printed to stdout; copy it into the React app's local storage to use the UI.

### Domain modules (V2)

Four shipped Modules under [`modules/`](modules/), each with its own schema, service, HTTP routes, Skills, and event contributions:

- **`projects`** — projects, phases, tasks, subtasks, dependencies. The central module — every other module references project ids.
- **`email`** — light triage surface for `MaildirEmailSource` (dev/offline). File emails to projects, create a new project from an email, extract structured scope into `<project>/in/<dated>/scope.md`. GraphEmailSource is a deferred sub-phase.
- **`proposals`** — estimates + proposals with a Mustache → Markdown render path. Pandoc-based PDF/docx rendering when `pandoc` is on PATH; markdown is always produced.
- **`invoicing`** — local invoices + payments, project budget view, and QuickBooks Online push/pull/reconcile (single-realm). When `QBO_*` env vars are unset the panel still works locally and shows a "Connect QBO" banner.

### Frontend

React + Vite SPA at [`src/web/`](src/web/) — chat as a route, top bar + left sidebar + centred chat pane, module panels under their own routes. See [ADR 0006](docs/adr/0006-frontend-shell-architecture.md) and [ADR 0007](docs/adr/0007-module-panel-conventions.md).

---

## Requirements

- Node.js 20+
- [LM Studio](https://lmstudio.ai/) running locally (default `http://localhost:1234/v1`) for the general / compressor / embedding tiers
- *(Optional)* An OpenRouter API key for expert consultation
- *(Optional)* `pandoc` on PATH for PDF/docx proposal rendering
- *(Optional)* A QuickBooks Online developer app (client id + secret) for invoicing sync
- Windows, macOS, or Linux

---

## Quick start

```bash
npm install
npm run web:install     # one-time: install frontend deps
cp .env.example .env    # then edit — see "Configuration" below
npm run web:build       # build the React frontend into src/web/dist
npm run dev             # watches and restarts on change
```

On first boot the server prints the auth token to stdout. Copy it into the React app's "Auth token" field (Settings → API) to start using the UI.

Open [http://127.0.0.1:3737](http://127.0.0.1:3737) for the chat UI and module panels.

For active frontend work, run the Vite dev server in a second terminal — it proxies `/api` + `/ws` to Fastify on port 3737:

```bash
npm run web:dev         # http://localhost:5174
```

Other scripts:

```bash
npm start               # production-style: no watcher
npm run start:full      # web:build + start
npm run dev:full        # web:build + dev (watcher)
npm test                # vitest run (backend)
npm run test:watch
npm run typecheck
npm run web:test        # frontend tests
```

---

## Configuration

All settings come from environment variables (loaded from `.env` when present). The full schema lives in [src/server/config.ts](src/server/config.ts); the most relevant ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3737` / `127.0.0.1` | HTTP + WebSocket listener |
| `ALLOWED_ORIGINS` | *(loopback aliases)* | Comma-separated extra `Origin` values to allow on browser requests |
| `ALLOW_UNAUTH_NETWORK` | `0` | Acknowledge that binding non-loopback exposes the API beyond the local machine |
| `DB_PATH` | `./data/agentone.db` | SQLite database (sessions, history, FTS, embeddings, audit log, modules) |
| `STORAGE_ROOT` | `./storage` | Root of the three-tree layout (`wiki/`, `projects/`, `drafts/`) + `.auth/token` |
| `SKILLS_DIR` | `./skills` | Where the loader scans for top-level `SKILL.md` files (modules contribute their own) |
| `AGENT_PROFILES_DIR` | `./profiles/agents` | Agent profile YAMLs |
| `MODEL_PROFILES_DIR` | `./profiles/models` | Model profile YAMLs |
| `AGENT_PROFILE` | `_base` | Default profile used when a new session doesn't specify one |
| `DEFAULT_MODEL_PROFILE` | `local-fast` | Conversation model |
| `COMPRESSOR_MODEL_PROFILE` | `local-compressor` | Context-window compression model |
| `EMBEDDING_MODEL_PROFILE` | `local-embed` | Embeddings for history / wiki recall |
| `FRONTEND_DIR` | `./src/web/dist` | Where Fastify serves the built React SPA from |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio endpoint |
| `OPENROUTER_API_KEY` | *(unset)* | Enables `consult_expert` |
| `AUDIT_LOG_PATH` | *(unset)* | If set, the example audit-log hook writes one JSONL record per tool call |
| `EVENT_HOOKS_PATH` | *(unset)* | YAML file declaring event-bus subscribers |
| `LOG_EVENTS` | `0` | Persist all bus events to the `event_log` table |
| `EMAIL_MAILDIR_PATH` | *(unset)* | Folder of `.eml` files for the Maildir email source |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` | *(unset)* | Intuit OAuth2 app credentials; both required to enable QBO push/pull |
| `QBO_AUTHORIZE_URL` | `https://appcenter.intuit.com/connect/oauth2` | Override for sandbox vs production |
| `QBO_TOKEN_KEY` | *(unset)* | AES-GCM key for QBO token vault on non-Windows; Windows DPAPI used when available |
| `QBO_PULL_INTERVAL_MIN` | `15` | Minutes between scheduled QBO drift-pull passes |

The bearer token at `<STORAGE_ROOT>/.auth/token` is auto-generated; it's not an env var. Delete the file to rotate.

---

## Project layout

```
modules/                   V2 domain modules (drop a folder → service + schema + routes + Skills)
  projects/                  central module: project / phase / task / dependencies
  email/                     email triage + file-to-project / create-new-project / scope-extractor
  proposals/                 estimates + proposals + Mustache → markdown rendering
  invoicing/                 invoices + payments + project_budget view + QBO sync
profiles/                  Agent + Model profiles (YAML)
  agents/_base.yaml          base profile; every other agent extends this
  models/*.yaml              one file per LLM endpoint, tagged with a role
prompts/base.md            System prompt scaffold
skills/                    Filesystem-scanned skill tree (top-level; modules contribute their own)
  system/                    filesystem, shell, web, memory, documents
  experts/consult            consult_expert wiring
src/
  server/                    Fastify app, WebSocket, slash-command registry, auth gate
    auth.ts                  Bearer-token gate for /api/* and /ws
    config.ts                Env-var schema
    background-drain.ts      Drains the orchestrator stream off the request path
  orchestrator/              Per-turn loop (tool calls, streaming, hooks, spawned sessions)
  providers/                 LM Studio + OpenRouter adapters + Hermes parsing
  context/                   Prompt composer, compression, passive recall
  memory/wiki/               Wiki engine (read/write/edit/search/backlinks)
  search/                    Hybrid recall (FTS5 + embeddings)
  skills/                    Loader, registry, core-tools, frontmatter, hooks
  modules/                   Module boot machinery + cross-cutting helpers
    registry.ts              Filesystem discovery + topological boot + ScopedModuleRegistry
    migrations.ts            Per-module schema_migrations runner
    audit-log.ts             Immutable record of Module mutations
    notifications.ts         User-facing tray store
    action-discovery.ts      Generic GET /api/<module>/actions endpoint
    qbo/                     QBO OAuth + push/pull/poller (consumed by modules/invoicing)
  storage/                   SQLite schema + local-folder adapter + secret vault
  web/                       React + Vite SPA (chat + module panels)
docs/PRD.md                Product requirements
docs/adr/                  Architecture decision records
docs/planning/             V2 phase impl specs + punch lists (historical record)
CONTEXT.md                 Domain language and relationships
CLAUDE.md                  Project instructions for Claude Code
```

---

## Slash commands

Built-in system commands (handled by the server, not the model):

| Command | What it does |
| --- | --- |
| `/new` | Start a new session against the current or named agent profile |
| `/sessions` | List recent sessions |
| `/load <skill>` | Load a skill into the current session |
| `/compact` | Force a context-compression pass now |
| `/clear` | Drop in-session context (history stays in the DB) |
| `/cost` | Show the current session's expert spend ledger |
| `/help` | List commands |

Skills can also declare their own `slash_command` in frontmatter — those go through the agent. Module Skills register theirs alongside the top-level tree (e.g. `/create-project`, `/file-to-project`, `/build-estimate`, `/create-invoice`).

---

## Storage layout

`STORAGE_ROOT` holds three sibling trees, kept separate so authorship is never ambiguous (see [ADR 0002](docs/adr/0002-three-tree-storage-layout.md)):

- `wiki/` — agent-authored markdown, the long-term memory
- `projects/` — stakeholder-authored documents (read-only for binaries) plus `projects/<n>/in/` (email-filed inputs) and `projects/<n>/drafts/` (generated proposals)
- `drafts/` — agent-generated outputs not tied to a project (proposals, diagrams, exports)

Plus `<STORAGE_ROOT>/.auth/token` — the persisted auth bearer.

Point `STORAGE_ROOT` at a synced folder (SharePoint, Dropbox, etc.) to share the workspace across machines.

---

## Further reading

- [docs/PRD.md](docs/PRD.md) — full requirements + user stories
- [docs/planning/v2-business-flow.md](docs/planning/v2-business-flow.md) — V2 module domain decisions
- [docs/adr/0001-skill-system-as-primary-extensibility.md](docs/adr/0001-skill-system-as-primary-extensibility.md) — why skills, not plugins
- [docs/adr/0002-three-tree-storage-layout.md](docs/adr/0002-three-tree-storage-layout.md) — wiki / projects / drafts split
- [docs/adr/0003-event-bus-is-observational.md](docs/adr/0003-event-bus-is-observational.md) — bus is for observation, not control flow
- [docs/adr/0004-modules-as-second-extensibility-primitive.md](docs/adr/0004-modules-as-second-extensibility-primitive.md) — Modules
- [docs/adr/0005-non-chat-session-activation.md](docs/adr/0005-non-chat-session-activation.md) — spawned sessions, awaiting input, notifications
- [docs/adr/0006-frontend-shell-architecture.md](docs/adr/0006-frontend-shell-architecture.md) — React shell decisions
- [docs/adr/0007-module-panel-conventions.md](docs/adr/0007-module-panel-conventions.md) — module panel conventions

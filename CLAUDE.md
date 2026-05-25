# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Domain language

Read [CONTEXT.md](CONTEXT.md) before reasoning about the system — it defines the project's vocabulary (Skill, Module, Core Tool, Agent/Model Profile, Role, Wiki, Audit Log, etc.). Use those terms exactly. ADRs in [docs/adr/](docs/adr/) document the load-bearing decisions (skills as primary extensibility, three-tree storage, observational event bus, Modules as second primitive).

## Common commands

```bash
npm run dev             # backend watcher on :3737 (node --watch + tsx)
npm run web:dev         # vite frontend dev server on :5174, proxies /api + /ws
npm run dev:full        # web:build + dev (no vite watcher; serves built UI)
npm start               # production-style: no watcher
npm run web:install     # one-time: install frontend deps
npm run web:build       # build React frontend into src/web/dist

npm test                # vitest run (backend, tests/**/*.test.ts)
npm run test:watch
npm run web:test        # frontend vitest
npm run typecheck       # tsc --noEmit
```

Run a single backend test: `npx vitest run tests/projects-service.test.ts` (or `-t "test name"`).

Smoke scripts live under [scripts/](scripts/) (`smoke.mjs`, `smoke-cancel.mjs`, `smoke-passive-recall.mjs`, etc.) — `node scripts/<name>.mjs`. `scripts/backup-db.mjs` snapshots `data/agentone.db`.

The repo is ESM (`"type": "module"`); TypeScript compiles via `tsx` at runtime, so imports use `.js` extensions even when the source is `.ts`.

## Architecture

### Two extensibility primitives

- **Skills** ([skills/](skills/) and `modules/<m>/skills/`) — discoverable units of agent capability. Each is a `SKILL.md` (frontmatter + prose) optionally bundling TypeScript tool handlers. The loader scans on boot; drop a folder, get a Skill. Skill tools are session-scoped and only registered after `load_skill`. See [docs/adr/0001](docs/adr/0001-skill-system-as-primary-extensibility.md).
- **Modules** ([modules/](modules/) — `projects`, `email`, `proposals`, `invoicing`) — schema-owning, event-emitting, skill-bundling domains. Each ships `MODULE.md`, versioned `schema/*.sql`, a `createService({ db, eventBus, storage, otherModules })` factory under `src/`, and its own Skills. A Module's service is callable by **any** in-process actor (Skill handlers, HTTP routes, hooks, schedulers, other Modules) — the agent is one client, not the gatekeeper. Every mutation writes to the immutable `audit_log` so chat history isn't the only record. See [docs/adr/0004](docs/adr/0004-modules-as-second-extensibility-primitive.md).

Module boot: filesystem scan → topological sort by `depends_on` → apply migrations → instantiate services → expose via `ModuleRegistry` in `ToolContext` and HTTP request context. Cross-module access goes through `ScopedModuleRegistry` (declared `depends_on` only, enforced at factory time). Skill handlers reach modules via `ctx.modules.getActiveService<T>('name')` — never raw `as`-casts. Failure is **degraded, not fatal**.

### Core tools vs. skill tools

Core Tools are always loaded because they are *architectural*, not just useful: `list_skills`, `load_skill`, `consult_expert`, `search_history`, `wiki_*`, `request_user_input`. Anything else lives in a Skill. When deciding where a new capability goes, apply the test from CONTEXT.md: would the system architecturally make sense without it? If yes → Skill.

### Per-turn orchestration

[src/orchestrator/turn.ts](src/orchestrator/turn.ts) drives the tool-call loop:

1. `composeSystemMessage` builds the system prompt (base prompt + agent profile additions + default-skill headers + category descriptions + recall block).
2. `dispatchToolCallsPhase` runs the tool loop with `PermissionGate` enforcing what the profile may load.
3. `ContextManager` synchronously compresses at 80% of the window; oversized tool results are truncated head+tail at 60%.
4. `passive-recall` optionally injects a wiki + cross-session history probe per user turn.
5. `HookRegistry` runs cross-cutting hooks (deny rules, redaction, audit logging) around every tool call.

### Two-tier providers

`general` / `compressor` / `embedding` roles go to LM Studio by default; `expert` Models are reached only via the `consult_expert` Core Tool against OpenRouter, with per-call and per-session budget tracking ([src/skills/expert-spend.ts](src/skills/expert-spend.ts)). Agent Profiles reference **Roles**, not model IDs — swap the model in `profiles/models/*.yaml` without touching agent profiles.

### Event bus is observational

[docs/adr/0003](docs/adr/0003-event-bus-is-observational.md): the bus is for observation, not control flow. Hooks subscribe; the runtime never blocks on a subscriber. Persist all events by setting `LOG_EVENTS=1` (writes to `event_log` table). Distinct from the `audit_log` (immutable, complete, Module-mutation-only).

### Three-tree storage

`STORAGE_ROOT` holds three sibling trees that must never be conflated ([docs/adr/0002](docs/adr/0002-three-tree-storage-layout.md)):

- `wiki/` — agent-authored markdown, long-term memory, `[[wiki-links]]`
- `projects/` — stakeholder-authored documents (PDF/CAD/Office), agent-read-only for binaries
- `drafts/` — agent-generated outputs (proposals, diagrams, exports)

The agent links into `projects/` from the wiki via `[[file:projects/...]]`; documents do not link back.

### Frontend

React + Vite under [src/web/](src/web/). Vite dev server (`npm run web:dev`, port 5174) proxies `/api` and `/ws` to Fastify on 3737. For production-like runs, `web:build` outputs to `src/web/dist/` and Fastify serves it via `@fastify/static`. Frontend shell architecture is captured in [docs/adr/0006](docs/adr/0006-frontend-shell-architecture.md); module panel conventions in [docs/adr/0007](docs/adr/0007-module-panel-conventions.md).

### Slash commands

System Commands (`/new`, `/sessions`, `/load`, `/compact`, `/clear`, `/cost`, `/help`) are handled by the server *without* invoking a model — they live in [src/server/commands/](src/server/commands/). Skills can also declare a `slash_command` in frontmatter; those go through the agent. System Command names are reserved.

## Conventions

- ESM with `.js` import extensions in TypeScript sources.
- Tests live in [tests/](tests/) (not colocated). Pattern: `tests/<feature>.test.ts`. Vitest config in [vitest.config.ts](vitest.config.ts) provides `@/` → `src/`.
- Configuration is entirely env-driven via [src/server/config.ts](src/server/config.ts); the operator prefers config (e.g. agent profiles) editable from the UI, not git-only YAML — when adding new config surfaces, prefer routes + UI over more env vars where reasonable.
- Skill handlers must use `ctx.modules.getActiveService<T>('name')` for cross-module reach; raw `as` casts on Module services were removed deliberately and should not return.
- Module dependencies are declared in `MODULE.md` `depends_on` frontmatter and enforced at factory wiring time — adding a cross-module call without updating `depends_on` will fail at boot.

# AgentOne

A local, single-user, event-driven agent runtime with persistent memory.

AgentOne pairs a small architectural core (memory + provider tier + skill discovery) with a filesystem-based skill system for everything else. Local LM Studio models do the everyday work; OpenRouter experts (Opus, GPT-5.5, Deepseek) are reachable as a tool when a problem genuinely needs them.

See [CONTEXT.md](CONTEXT.md) for the domain language and [docs/PRD.md](docs/PRD.md) for the full product spec.

---

## What it is

- **Karpathy-style wiki** — agent-authored markdown notes that survive across sessions, queryable by path, search, and backlinks.
- **Conversation history** — every turn persisted in SQLite, indexed with FTS5 + local embeddings, recallable across sessions.
- **Project documents** — stakeholder PDFs / Office files / CAD live under `projects/`, readable via the `system/documents` skill with pagination and per-format extraction.
- **Skill system** — drop a folder under `skills/`, optionally bundle TypeScript handlers, and the agent discovers it on next start. Pure-prose skills (just `SKILL.md`) are first-class.
- **Two-tier providers** — LM Studio by default; OpenRouter via the `consult_expert` core tool, with per-call and per-session budgets.
- **Agent + Model Profiles** — YAML configs with single-level inheritance from `_base`. Agent profiles reference *roles* (general / compressor / embedding / expert), not model IDs, so swapping models doesn't touch profiles.
- **Event bus** — every meaningful action emits an event; the browser UI streams them and hooks can subscribe (see ADR [0003](docs/adr/0003-event-bus-is-observational.md)).
- **Context management** — synchronous compression at 80% of the window, oversized tool results truncated head+tail at 60%.

---

## Requirements

- Node.js 20+
- [LM Studio](https://lmstudio.ai/) running locally (default `http://localhost:1234/v1`) for the general / compressor / embedding tiers
- *(Optional)* An OpenRouter API key for expert consultation
- Windows, macOS, or Linux

---

## Quick start

```bash
npm install
cp .env.example .env   # then edit — see "Configuration" below
npm run dev            # watches and restarts on change
```

Open [http://127.0.0.1:3737](http://127.0.0.1:3737) for the chat UI.

Other scripts:

```bash
npm start         # production-style: no watcher
npm test          # vitest run
npm run test:watch
npm run typecheck
```

---

## Configuration

All settings come from environment variables (loaded from `.env` when present). The full schema lives in [src/server/config.ts](src/server/config.ts); the most relevant ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3737` / `127.0.0.1` | HTTP + WebSocket listener |
| `DB_PATH` | `./data/agentone.db` | SQLite database (sessions, history, FTS, embeddings, event log) |
| `STORAGE_ROOT` | `./storage` | Root of the three-tree layout (`wiki/`, `projects/`, `drafts/`) |
| `SKILLS_DIR` | `./skills` | Where the loader scans for `SKILL.md` files |
| `AGENT_PROFILES_DIR` | `./profiles/agents` | Agent profile YAMLs |
| `MODEL_PROFILES_DIR` | `./profiles/models` | Model profile YAMLs |
| `AGENT_PROFILE` | `_base` | Default profile used when a new session doesn't specify one |
| `DEFAULT_MODEL_PROFILE` | `local-fast` | Conversation model |
| `COMPRESSOR_MODEL_PROFILE` | `local-compressor` | Context-window compression model |
| `EMBEDDING_MODEL_PROFILE` | `local-embed` | Embeddings for history / wiki recall |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio endpoint |
| `OPENROUTER_API_KEY` | *(unset)* | Enables `consult_expert` |
| `AUDIT_LOG_PATH` | *(unset)* | If set, the example audit-log hook writes one JSONL record per tool call |
| `LOG_EVENTS` | `0` | Persist all bus events to the `event_log` table |

---

## Project layout

```
profiles/          Agent + Model profiles (YAML)
  agents/_base.yaml      base profile; every other agent extends this
  models/*.yaml          one file per LLM endpoint, tagged with a role
prompts/base.md    System prompt scaffold
skills/            Filesystem-scanned skill tree
  system/                filesystem, shell, web, memory, documents
  experts/consult        consult_expert wiring
src/
  server/                Fastify app, WebSocket, slash-command registry
  orchestrator/          Per-turn loop (tool calls, streaming, hooks)
  providers/             LM Studio + OpenRouter adapters + Hermes parsing
  context/               Prompt composer, compression, passive recall
  memory/wiki/           Wiki engine (read/write/edit/search/backlinks)
  search/                Hybrid recall (FTS5 + embeddings)
  skills/                Loader, registry, core-tools, frontmatter, hooks
  storage/               SQLite schema + local-folder adapter
  frontend/              Static browser client served by Fastify
docs/PRD.md        Product requirements
docs/adr/          Architecture decision records
CONTEXT.md         Domain language and relationships
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

Skills can also declare their own `slash_command` in frontmatter — those go through the agent.

---

## Storage layout

`STORAGE_ROOT` holds three sibling trees, kept separate so authorship is never ambiguous (see [ADR 0002](docs/adr/0002-three-tree-storage-layout.md)):

- `wiki/` — agent-authored markdown, the long-term memory
- `projects/` — stakeholder-authored documents (read-only for binaries)
- `drafts/` — agent-generated outputs (proposals, diagrams, exports)

Point `STORAGE_ROOT` at a synced folder (SharePoint, Dropbox, etc.) to share the workspace across machines.

---

## Further reading

- [docs/PRD.md](docs/PRD.md) — full requirements + user stories
- [docs/adr/0001-skill-system-as-primary-extensibility.md](docs/adr/0001-skill-system-as-primary-extensibility.md) — why skills, not plugins
- [docs/adr/0002-three-tree-storage-layout.md](docs/adr/0002-three-tree-storage-layout.md) — wiki / projects / drafts split
- [docs/adr/0003-event-bus-is-observational.md](docs/adr/0003-event-bus-is-observational.md) — bus is for observation, not control flow

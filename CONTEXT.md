# AgentOne

A local, event-driven, single-user agent system. Combines a small architectural core (memory + provider tier + skill discovery) with two layers of extensibility: **Skills** for capabilities and **Modules** for domains (project management, email, proposals, invoicing).

## Language

**Skill**:
A discoverable unit of procedural knowledge — a markdown file (`SKILL.md`) with frontmatter, optionally bundling TypeScript tool handlers and supporting docs. The primary extensibility mechanism for agent *capabilities*.
_Avoid_: Plugin, extension

**Module**:
A schema-owning, event-emitting, skill-bundling domain (e.g. `projects`, `email`, `proposals`, `invoicing`). Owns its SQLite tables (via migrations), publishes its own event types, exposes a typed service interface, and ships the Skills that let the agent operate on its state. Modules are the extensibility mechanism for new *domains*; Skills are still the extensibility mechanism for new *capabilities* — including the capabilities that drive a Module. A Module's Skills live under `modules/<module>/skills/`, not under top-level `skills/`.
_Avoid_: Subsystem, package, app

**SKILL.md**:
The single source-of-truth file for one Skill, containing frontmatter (name, description, tools, permissions) and prose guidance for the agent.

**Category**:
A folder grouping related Skills, described by a `CATEGORY.md` file in that folder. Category descriptions appear in the agent's system prompt to support discovery.

**Default Skill**:
A Skill listed in an Agent Profile's `default_skills`. Its header (name + description + path) is injected into the system prompt at session start; its body is loaded on demand.

**Core Tool**:
An always-loaded tool that is part of the system architecture, not just a useful capability. Examples: `list_skills`, `load_skill`, `consult_expert`, `search_history`, `wiki_*`, `request_user_input`. Everything else lives in a Skill.

**Agent Profile**:
A YAML config defining one agent role — its default skills, load permissions, default model, and additional system prompt. Extends exactly one Base Profile (single-level inheritance).

**Base Profile**:
An Agent Profile intended to be extended. Supplies the conventional default skills (`system/filesystem`, `system/shell`, `system/web`) so most profiles don't repeat them.

**Model Profile**:
A YAML config for an LLM endpoint — provider, model ID, sampling params, context window, and **Role**.

**Role** (of a Model Profile):
The job a model is configured for. Values: `general` (conversation), `compressor` (context compression), `embedding` (vector indexing), `expert` (an OpenRouter target callable via `consult_expert`). Agent Profiles reference Roles, not specific model IDs, so the underlying model can be swapped without touching profiles.

**Provider Tier**:
The architectural split between local **LM Studio** models (default tier, used for general work) and **OpenRouter** models (expert tier, invoked via `consult_expert`).

**Expert**:
An OpenRouter-hosted model that a local model can consult mid-turn via the `consult_expert` Core Tool. Experts are tools, not separate runtimes.

**Wiki**:
The agent's long-term memory substrate — a tree of **markdown-only** files with `[[wiki-links]]`, stored under `wiki/` on the SharePoint drive. Authored by the agent. Karpathy-style. Every agent reads/writes it via Core Tools.

**Document**:
A stakeholder-authored project artifact (PDF, CAD, scope doc, image, spreadsheet, etc.) stored under `projects/` on the SharePoint drive. Read by the agent through the `system/documents` Default Skill; not part of the Wiki. The agent describes Documents in the Wiki via `[[file:projects/...]]` links.

**Drafts**:
Agent-generated non-Wiki outputs (proposal documents, generated diagrams, exports), stored under `drafts/` on the SharePoint drive. Kept separate from `projects/` so stakeholder-authored and agent-authored artifacts never get confused.

**Conversation History**:
The append-only log of past turns in SQLite, indexed with FTS5 + embeddings, queryable via the `search_history` Core Tool.

**Hook**:
A settings-level event handler that runs when an Event Bus event fires (e.g., a script that notifies a team channel on `wiki.written`). Hooks are configured outside the Skill system because they are ambient watchers, not agent capabilities. Trusted, in-process, settings-defined.

**Spawned Session**:
A Session created programmatically by a Module or HTTP route rather than by a human typing the first message. Shares the `sessions` row shape; differs only in provenance (recorded as `spawned_by`) and that it begins running immediately on the `seed.initialMessage`. Profile is chosen by the spawning Module from a whitelist the operator declares.

**Awaiting Input** (Session state):
A Session pauses in this state when the agent calls the `request_user_input` Core Tool. Resumes on the next user message. The runtime never promotes a Session to this state implicitly — it is always an explicit agent decision.

**Notification**:
A user-facing record (rows in the `notifications` table) emitted by a Module, the orchestrator, or a Hook. Surfaces work the user needs to see — either informational (`info`) or actionable (`attention_needed`, usually linked to a Session in `awaiting_input`). Distinct from the audit log: notifications are dismissable and user-facing; the audit log is immutable and complete.
_Avoid_: Alert, message, toast

**Audit Log**:
An immutable record of every Module-state mutation, written by Module services themselves. Exists because Module mutations bypass the agent — so the chat history is no longer a complete record of "what happened to the system."
_Avoid_: Log, history (overloaded with Conversation History)

**Module Registry**:
The in-process container holding instantiated Module services. Built at boot from the on-disk scan of `modules/`. Injected into `ToolContext` (so Skill handlers can reach `ctx.modules.projects`) and into HTTP request context (so route handlers can reach `app.modules.projects`). Singletons; one service instance per Module per runtime.

**Project Number**:
Operator-configured short identifier on a `project` row (format default `YY###`, e.g. `24001`). The canonical reference used in folder names (`projects/24001 - Riverside Reno/`), invoice numbers (`24001-01`), and human conversation. Distinct from the row's internal `id` (a ULID).

**EmailSource**:
Abstraction over the mail backend used by `modules/email/`. Two implementations: `GraphEmailSource` (Microsoft Graph, production default) and `MaildirEmailSource` (local `.eml` folder, dev/offline fallback). Narrow surface: list / get / mark / move. Outbound mail is intentionally out of scope.

**Scheduled Trigger**:
A cron-like task registered by a Module at boot (e.g. `invoicing.pollQbo` every 15 minutes). The primitive is extracted from the existing `AutoDistillScheduler` pattern; nothing user-facing changes. Distinct from Hooks — Hooks react to events; Scheduled Triggers fire on time.
_Avoid_: Cron job, timer, background task

**Slash Command**:
A UI affordance for invoking either a Skill (skill commands — declared by a Skill's `slash_command` frontmatter) or a server-side action (**System Commands** — `/new`, `/help`, `/load`, `/compact`, `/sessions`, `/clear`). System Command names are reserved; a Skill cannot use them.

**System Command**:
A Slash Command handled by the server without invoking a model — used for session lifecycle, manual context operations, and discovery. Distinct from skill commands, which always go through the agent.

## Relationships

- An **Agent Profile** extends exactly one **Base Profile**
- An **Agent Profile** lists zero or more **Default Skills**
- A **Skill** belongs to exactly one **Category** (top-level `skills/`) *or* to exactly one **Module** (under `modules/<module>/skills/`)
- A **Module** owns its tables, its event types, and the Skills underneath it; Skills are the only thing the agent sees, the Module's service is the only thing those Skills call
- A **Skill**, when loaded, may register zero or more session-scoped tools
- **Core Tools** are always available; **Skill** tools are scoped to a session and only after `load_skill`
- An **Expert** is invoked from a local model via `consult_expert`; the local model orchestrates the turn
- The **Wiki** is shared across all sessions; **Conversation History** is also shared, queryable across sessions
- The SharePoint drive is laid out as three sibling trees — `wiki/` (agent memory, markdown), `projects/` (stakeholder Documents), `drafts/` (agent-generated outputs)
- The **Wiki** may reference **Documents** via `[[file:projects/...]]`; Documents do not link back
- A **Module**'s service is callable from any in-process actor — Skills, HTTP routes, hooks, schedulers, other modules. The agent is one client, not the gatekeeper. Module mutations write to an audit log so the chat history is not the only auditable trail.

## Example dialogue

> **Dev:** "Should `read_file` be a **Core Tool**?"
> **Designer:** "No — it's a useful action, not architecture. It lives in the `system/filesystem` **Skill**, which the **Base Profile** loads as a **Default Skill**. An agent that opts out gets a sandboxed runtime for free."
>
> **Dev:** "What about `wiki_read`?"
> **Designer:** "Core. The **Wiki** is the agent's memory substrate — every agent in AgentOne is wiki-backed by definition. A wiki-less agent would be a different architecture."

## Flagged ambiguities

- "Plugin" (from the initial sketch) was used to mean what we now call **Skill**. Resolved: one mechanism, called **Skill**. There is no separate plugin system.
- "Tool" is overloaded: it can mean a **Core Tool** (always-loaded, architectural) or a skill-supplied tool (session-scoped, registered when a Skill is loaded). Use the qualifier when context isn't clear.
- "Project" is overloaded: in v1 it referred to the `projects/` folder tree (a Document namespace); in v2 it also names the `project` row in `modules/projects/`. Disambiguate by qualifier — "Project folder" or "Project record" — when context is unclear.
- "Log" is overloaded across three concepts: **Conversation History** (turns), the event log (observational, may drop), and the **Audit Log** (immutable, complete record of Module mutations). Use the qualifier.

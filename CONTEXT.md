# AgentOne

A local, event-driven, single-user agent system. Combines a small architectural core (memory + provider tier + skill discovery) with an extensible skill system for everything else.

## Language

**Skill**:
A discoverable unit of procedural knowledge — a markdown file (`SKILL.md`) with frontmatter, optionally bundling TypeScript tool handlers and supporting docs. The primary extensibility mechanism.
_Avoid_: Plugin, extension, module

**SKILL.md**:
The single source-of-truth file for one Skill, containing frontmatter (name, description, tools, permissions) and prose guidance for the agent.

**Category**:
A folder grouping related Skills, described by a `CATEGORY.md` file in that folder. Category descriptions appear in the agent's system prompt to support discovery.

**Default Skill**:
A Skill listed in an Agent Profile's `default_skills`. Its header (name + description + path) is injected into the system prompt at session start; its body is loaded on demand.

**Core Tool**:
An always-loaded tool that is part of the system architecture, not just a useful capability. Examples: `list_skills`, `load_skill`, `consult_expert`, `search_history`, `wiki_*`. Everything else lives in a Skill.

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

**Slash Command**:
A UI affordance for invoking either a Skill (skill commands — declared by a Skill's `slash_command` frontmatter) or a server-side action (**System Commands** — `/new`, `/help`, `/load`, `/compact`, `/sessions`, `/clear`). System Command names are reserved; a Skill cannot use them.

**System Command**:
A Slash Command handled by the server without invoking a model — used for session lifecycle, manual context operations, and discovery. Distinct from skill commands, which always go through the agent.

## Relationships

- An **Agent Profile** extends exactly one **Base Profile**
- An **Agent Profile** lists zero or more **Default Skills**
- A **Skill** belongs to exactly one **Category**
- A **Skill**, when loaded, may register zero or more session-scoped tools
- **Core Tools** are always available; **Skill** tools are scoped to a session and only after `load_skill`
- An **Expert** is invoked from a local model via `consult_expert`; the local model orchestrates the turn
- The **Wiki** is shared across all sessions; **Conversation History** is also shared, queryable across sessions
- The SharePoint drive is laid out as three sibling trees — `wiki/` (agent memory, markdown), `projects/` (stakeholder Documents), `drafts/` (agent-generated outputs)
- The **Wiki** may reference **Documents** via `[[file:projects/...]]`; Documents do not link back

## Example dialogue

> **Dev:** "Should `read_file` be a **Core Tool**?"
> **Designer:** "No — it's a useful action, not architecture. It lives in the `system/filesystem` **Skill**, which the **Base Profile** loads as a **Default Skill**. An agent that opts out gets a sandboxed runtime for free."
>
> **Dev:** "What about `wiki_read`?"
> **Designer:** "Core. The **Wiki** is the agent's memory substrate — every agent in AgentOne is wiki-backed by definition. A wiki-less agent would be a different architecture."

## Flagged ambiguities

- "Plugin" (from the initial sketch) was used to mean what we now call **Skill**. Resolved: one mechanism, called **Skill**. There is no separate plugin system.
- "Tool" is overloaded: it can mean a **Core Tool** (always-loaded, architectural) or a skill-supplied tool (session-scoped, registered when a Skill is loaded). Use the qualifier when context isn't clear.

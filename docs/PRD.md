# AgentOne — Product Requirements Document

A local, single-user, event-driven agent runtime with persistent memory (Karpathy-style wiki + conversation history), SharePoint-backed file storage, a small architectural core, and a skill-based extensibility model.

Companion documents:
- [`CONTEXT.md`](../CONTEXT.md) — domain language and relationships
- [`docs/adr/0001-skill-system-as-primary-extensibility.md`](./adr/0001-skill-system-as-primary-extensibility.md)
- [`docs/adr/0002-three-tree-storage-layout.md`](./adr/0002-three-tree-storage-layout.md)
- [`docs/adr/0003-event-bus-is-observational.md`](./adr/0003-event-bus-is-observational.md)

---

## Problem Statement

I want a local agent I can rely on across sessions — one that remembers what we worked on yesterday, knows the project context, can read the PDFs and CAD models stakeholders drop into our SharePoint drive, and uses local LLMs by default but can reach for a stronger model (Opus, GPT-5.5, Deepseek) when a problem genuinely needs it.

Existing options fall short:
- General chatbots forget everything; their "memory" is shallow and not user-controlled.
- Agent frameworks bury me in scaffolding before any value lands, and most have heavy always-loaded tool sets that crowd the model's context.
- Off-the-shelf RAG kits index documents but ignore the agent's own notes, decisions, and continuity.
- Nothing I've found combines a local-model-first runtime, a wiki for the agent's own memory, a SharePoint-backed file workspace, an extensible-but-minimal skill system, and per-agent permissioning.

I want one local app that does all of this — auditable, extensible by dropping a folder, and small enough that I trust the parts.

---

## Solution

A Node.js application running locally, exposing a browser chat UI, structured as an event-driven agent runtime with:

- **A small architectural core** (~8 always-loaded Core Tools): skill discovery, wiki access, history search, expert consultation. Everything else lives in **Skills**.
- **A Skill system** — markdown documents with optional TypeScript tool handlers — that supplies filesystem, shell, web access, documents, and any further capability. Skills are discovered by filesystem scan; their headers appear in the system prompt; their bodies load on demand.
- **A persistent Wiki** of agent-authored markdown notes on SharePoint, the agent's long-term memory.
- **Project Documents** (PDFs, CAD, scope docs) on SharePoint in a separate tree, readable via a `system/documents` Skill with pagination and per-format extraction.
- **Conversation History** in SQLite, indexed with FTS5 + local embeddings, searchable across sessions.
- **A two-tier provider model**: LM Studio for general work, OpenRouter (Opus 4.7, GPT-5.5, Deepseek V4) reachable via a `consult_expert` tool with per-call and per-session budgets.
- **Agent Profiles and Model Profiles** as YAML configs, with single-level inheritance from a `_base` profile and NACL-style permission resolution.
- **An event bus** for pub/sub observability, feeding the UI stream, hooks, and an event log table.
- **Context management** with synchronous compression at 80% of the model's window and head+tail+reference truncation of oversized tool results at 60%.

---

## User Stories

### Conversation and session lifecycle

1. As the operator, I want to start a new conversation by picking an agent profile, so that I can use the right persona/permissions for the task.
2. As the operator, I want my conversations persisted automatically, so that I can return to any past thread without thinking about saving.
3. As the operator, I want to resume any past session indefinitely, so that long-running projects don't lose continuity.
4. As the operator, I want conversation titles to be generated automatically from the first few turns, so that I don't have to title threads before knowing what they become.
5. As the operator, I want to rename a session title, so that I can curate the list to be findable later.
6. As the operator, I want a session's agent profile fixed at creation, so that the security and capability model doesn't shift mid-conversation in ways I can't track.
7. As the operator, I want to send messages and see streamed token output, so that long replies feel responsive.
8. As the operator, I want to cancel a running turn, so that I can stop bad trajectories cheaply.
9. As the operator, I want cancellation to wait briefly for in-flight tool calls before hard-aborting, so that partial state is rare.

### Skills and tools

10. As the operator, I want default skills surfaced compactly in the agent's prompt (name + description + path), so that the agent knows what it can reach for without crowding context.
11. As the operator, I want categories of skills surfaced too (name + description), so that the agent can discover capabilities not loaded by default.
12. As the operator, I want the agent to load a skill on demand via a tool call, so that capability expands only when needed.
13. As the operator, I want to invoke a skill directly via a slash command, so that I can drive the agent's behavior explicitly when I know what I want.
14. As a skill author, I want to add a new capability by dropping a folder, so that extension is trivially low-friction.
15. As a skill author, I want a skill to be pure prose (just SKILL.md) when no new code is needed, so that procedural-only skills cost nothing structurally.
16. As a skill author, I want optional TypeScript handlers bundled alongside SKILL.md so that capability-extending skills declare their tools next to their prose.
17. As a skill author, I want parameter schemas to live in the handler module (not in SKILL.md frontmatter), so that the schema and the code stay in sync.
18. As a skill author, I want my skill to declare `allowed-tools` as a needs declaration (not a permission grant), so that missing dependencies fail at load time, not at runtime.
19. As the operator, I want to manually trigger a skill load via `/load <name>`, so that I can prime a session before issuing a request.
20. As the operator, I want to browse the full skill catalog, so that I can see what's available without reading SKILL.md files.

### Memory — wiki, history, documents

21. As the operator, I want the agent to maintain a markdown wiki on SharePoint, so that its long-term notes survive across sessions and are editable outside the system.
22. As the operator, I want wiki pages identified by path with a humane name alias, so that renames don't break links and authoring feels natural.
23. As the operator, I want wiki tools to support read, write, append, edit, search, and backlinks, so that the agent can maintain a useful knowledge graph without read-modify-write hacks.
24. As the operator, I want stakeholder-authored project files (PDFs, CAD, scope docs) accessible to the agent, so that real project context informs its answers.
25. As the operator, I want stakeholder files in their own tree (`projects/`), separate from agent notes (`wiki/`) and agent-generated outputs (`drafts/`), so that authorship is unambiguous at a glance.
26. As the operator, I want the agent to read PDFs and Office documents with text extraction, so that I don't have to convert files myself.
27. As the operator, I want the agent to read large documents in pages, so that one tool call doesn't blow the context window.
28. As the operator, I want the agent to see a document's section list (TOC, headings) when available, so that it can jump to relevant parts rather than paginate blindly.
29. As the operator, I want CAD models and other binaries to be visible to the agent as metadata even when content can't be extracted, so that the agent at least knows what exists.
30. As the operator, I want the agent to be able to write text/markdown into `projects/` but not overwrite binaries, so that I can't accidentally corrupt stakeholder source files.
31. As the operator, I want past conversations searchable, so that I can find what we decided three weeks ago.
32. As the operator, I want three separate search tools (wiki, history, documents), so that the provenance of facts the agent surfaces is clear.
33. As the operator, I want the agent to recall before answering on topics that may have history, taught via a `system/memory` skill, so that responses cite prior context rather than reinventing it.

### Providers and expert escalation

34. As the operator, I want LM Studio as the default provider, so that everyday work stays local, private, and free.
35. As the operator, I want to swap the underlying model without touching agent profiles, via role-tagged Model Profiles, so that experimenting with new local models is cheap.
36. As the operator, I want the local agent to consult an expert (Opus 4.7, GPT-5.5, Deepseek V4) when a question is genuinely beyond its tier.
37. As the operator, I want expert consultations to be a question-and-answer tool (not a sub-agent), so that semantics stay simple and predictable.
38. As the operator, I want the local model to curate what context the expert sees, so that I can audit the consultation and the call stays cheap.
39. As the operator, I want per-call and per-session budgets for expert use, configured per agent profile, so that escalation can't silently rack up costs.
40. As the operator, I want the expert's response to include metadata (model, tokens, cost, latency), so that the local model can learn judgment about when to escalate.

### Context window management

41. As the operator, I want context compression to fire automatically at 80% of the model's window, so that long conversations stay viable.
42. As the operator, I want compression to be lossless (originals archived), so that I can rehydrate compressed turns from history when needed.
43. As the operator, I want the compressor model to be configurable per agent profile, so that compression can use a fast, cheap model distinct from the conversation model.
44. As the operator, I want compressed summaries to keep tool calls and outcomes verbatim (rather than narrative-summarized), so that factual provenance survives compression.
45. As the operator, I want oversized tool results truncated with head+tail+reference rather than dropped, so that the agent can still re-read the original if needed.
46. As the operator, I want a `read_turn(id)` tool, so that the agent can rehydrate truncated content deliberately.
47. As the operator, I want the agent to know when compression has happened, so that it can search history rather than fabricate from the summary.

### Permissions and profiles

48. As the operator, I want each agent profile to declare a default skill set, so that capability is bound to role.
49. As the operator, I want agent profiles to extend a `_base` profile (single level), so that conventional defaults aren't re-declared everywhere.
50. As the operator, I want permissions composed across base + child profiles with deny-precedence (NACL-style), so that policy is predictable.
51. As the operator, I want skill permissions in glob form with optional explicit denies, so that "everything in this category except X" is concise.
52. As the operator, I want expert permissions as a separate axis from skill permissions, so that cost control is unambiguous and visible.
53. As the operator, I want a sandboxed agent profile expressible by omitting `system/*` skills from defaults, so that constrained agents are a profile change, not a code change.

### UI and slash commands

54. As the operator, I want a browser chat UI as the primary interface, so that I don't need a special client.
55. As the operator, I want slash autocomplete in the message input, so that commands and skills are discoverable.
56. As the operator, I want `/new`, `/help`, `/sessions`, `/load`, `/compact`, `/clear` as system commands, so that lifecycle and admin actions are at my fingertips.
57. As the operator, I want system commands to bypass the model, so that they're instant and don't burn tokens.
58. As the operator, I want skill commands to load the skill and forward my text as a user message, so that `/deep-dive <topic>` is one step instead of three.
59. As the operator, I want tool calls visible in the message stream (skill loads, searches, expert consultations), so that I can see what the agent is doing in real time.
60. As the operator, I want expert calls to show their projected/actual cost in the stream, so that I have a budget-awareness handle.

### Observability and hooks

61. As the operator, I want every "thing that happened" event persisted to an event log, so that I can audit and debug sessions later.
62. As the operator, I want streaming-frequency events (token deltas) to be transient (not persisted), so that the event log doesn't bloat.
63. As the operator, I want to configure hooks (scripts that run on events) outside the skill system, so that ambient watchers don't conflate with agent capabilities.
64. As the operator, I want a settings file to declare hooks, so that automation is git-trackable.

### Storage and sync

65. As the operator, I want files on SharePoint to be the source of truth, so that browser/mobile/desktop SharePoint access just works.
66. As the operator, I want OneDrive sync (mounted folder) as the primary access pattern on Windows, so that I get free conflict resolution and offline support.
67. As the operator, I want a local-folder storage mode for development and offline work, so that I can build and test without SharePoint credentials.
68. As the operator, I want SharePoint conflicts handled by OneDrive's existing conflict-file mechanism, so that I rely on a battle-tested layer rather than implementing my own merge.
69. As the operator, I want embeddings computed locally by a small model (e.g. nomic-embed-text via LM Studio), so that semantic search has no external dependency or cost.
70. As the operator, I want all indexes stored in the same SQLite database, so that backup is one file.

### Errors and reliability

71. As the operator, I want tool failures to reach the agent as structured results (not exceptions), so that the agent can recover semantically.
72. As the operator, I want a small, stable error taxonomy (validation, runtime, timeout, permission, resource, budget, rate-limit, skill-load), so that error handling is uniform across skills.
73. As the operator, I want the runtime to auto-retry transient network errors with backoff, so that I don't see flicker from infrastructure noise.
74. As the operator, I want compression failure to fall back to aggressive truncation rather than fail the turn, so that plumbing problems never block my work.
75. As the operator, I want per-tool timeouts (system default 10s, override per handler), so that long-running tools don't make every tool feel slow.

---

## Implementation Decisions

### Architectural pillars

- **Skills are the primary extensibility mechanism.** Core Tools are limited to what is structurally necessary (skill discovery, wiki access, history search, expert consultation, archive recovery). Everything else — filesystem, shell, HTTP, document handling — lives in Skills. [ADR-0001]
- **Hybrid Skill model.** A Skill is markdown procedural knowledge (SKILL.md) with optional bundled TypeScript handlers. Pure-prose skills are first-class; capability-bundling skills declare tools in frontmatter and ship handlers in a sibling `tools/` folder.
- **Skill code is trusted, in-process.** TypeScript modules loaded via dynamic `import()` at skill-load time; no worker isolation or sandbox in v1. Trust model: skills are hand-written by the operator.
- **Filesystem-as-source-of-truth for skills.** The on-disk skill tree (under `skills/<category>/<skill>/`) is canonical. Dropping a folder adds a skill; no registry to sync.

### Storage layout

- **Three-tree SharePoint layout** [ADR-0002]: `wiki/` (agent-authored markdown), `projects/` (stakeholder-authored documents), `drafts/` (agent-generated non-wiki outputs).
- **StorageAdapter interface** with implementations: OneDriveMountAdapter (production default on Windows), LocalFolderAdapter (dev/offline), GraphAdapter (deferred until needed). Picked at startup; fails fast on config mismatch.

### Memory subsystem

- **Wiki**: page identity is path; humane `name:` frontmatter resolves to path via in-memory index. Both `[[Name]]` and `[[path]]` link forms supported. `[[file:projects/...]]` references project Documents from the Wiki.
- **Six Core wiki tools**: `wiki_read`, `wiki_write` (overwrite), `wiki_append`, `wiki_edit` (find/replace), `wiki_search`, `wiki_backlinks`. No `wiki_link` (the `[[brackets]]` syntax does the work); no `wiki_list` (search with empty query covers it).
- **Documents skill** (`system/documents`, Default in `_base`): paginated `doc_read`, `doc_list`, `doc_search`. Per-format extraction (PDF text via pdfjs/poppler, Office via textract/mammoth, binaries return metadata only). Indexing runs synchronously on agent writes, asynchronously via filesystem watcher on external changes.
- **Conversation History**: `turns` table with FTS5 over content and a vector column. `search_history` Core Tool returns ranked hits with turn IDs the agent can rehydrate via `read_turn`.
- **Pull-only recall**: no automatic pre-prompt retrieval. The agent calls search tools when relevant, primed by a `system/memory` Default Skill teaching when to recall.

### Skill mechanics

- **SKILL.md frontmatter schema** (locked): only `name` and `description` required. Optional: `tools` (list of `{id, handler, description}`), `allowed-tools` (needs declaration, not permission grant), `slash_command` (auto-derives from name when absent), `docs`, `version`.
- **Parameter schemas live in handler TS modules** (not frontmatter) as Zod schemas; the loader imports the module and reads `parameters`.
- **Skill loading** is via `load_skill(name)` Core Tool (model-driven) or `/slash-command` (user-driven). The full SKILL.md content lands as a tool-call result in conversation history; the skill's tools register session-scoped. Compression may elide loaded SKILL.md content; the agent re-loads if needed.
- **Discovery**: `list_skills(category?, query?)` Core Tool returns headers; the system prompt shows category descriptions and default skill headers, never the full catalog by default.
- **Permissions**: glob+deny on `permissions.skills`; deny-precedence union across base+child profiles. `permissions.experts.allow` is a separate axis; budgets (`budget_per_call_usd`, `budget_per_session_usd`) enforced at `consult_expert` invocation.

### Provider tier and consult_expert

- **Provider abstraction**: a `Provider` interface with `chat`, `tokenize`, `capabilities`. LM Studio and OpenRouter implementations.
- **Model Profile Roles**: `general`, `compressor`, `embedding`, `expert`. Agent Profiles reference roles; the runtime resolves to a concrete Model Profile.
- **`consult_expert` semantics**: synchronous Q&A only. Caller-curated context (the local model supplies any background as a `context` argument; no auto-injection of conversation). Experts cannot use tools. Returns text + metadata (model, tokens, cost, latency, finish_reason).
- **Budget enforcement**: per-call cap and per-session cap declared in agent profile. Exceeding either returns a `BUDGET_EXCEEDED` tool error.
- **No sub-agents in v1**. `spawn_agent` is explicitly a future, separate primitive — not smuggled into `consult_expert`.

### Sessions

- A Session = one conversation thread + one row in `sessions`. Created explicitly via `/new` or UI button; agent profile bound at creation and immutable for the session's lifetime. Resumable indefinitely. Titled automatically after a few turns; user-renamable.

### Prompt assembly

- **Single composed system message** at session start: base prompt → agent profile prompt → default skill headers → category list → storage layout hint. Static for the session's lifetime; the tool registry mutates as skills load, but the prompt text does not.
- **Compressed summary** lands as a separate synthetic system-role message between the static system block and the verbatim recent turns.
- **`prompts/base.md` scope**: invariant facts (identity, memory model, core tool awareness, wiki invariants, escalation philosophy). Heuristics (when to recall, when to escalate) live in `system/memory` and other `system/*` skills.
- **Soft cap** ~1500 tokens on the static system block; warn but don't fail above it.

### Context manager (60/80 rules)

- **80% compression**: synchronous, before each turn that would exceed the threshold. Compressor model declared per agent profile. Summary is hybrid (prose narrative + compact tool-call log). Verbatim recency window of ~6 turns preserved. Summary ends with a recoverability hint (`N earlier turns omitted; recoverable via search_history`).
- **60% truncation**: oversized tool results (e.g. a 50k-token PDF extract) replaced with head ~500 + tail ~500 + reference to `read_turn(turn_id)`. Agent results and user messages are never auto-truncated.
- **Compression failure** falls back to aggressive truncation (drop oldest N turns without summary), annotated; never fails the turn.

### Pagination

- **Page-based pagination** on `doc_read`, `read_turn`, `wiki_read`. Default page size 4000 tokens (8000 for wiki). Optional `section` (jump by structure) and `offset/length` (advanced) parameters. ~150-token overlap between pages.
- **Invariant**: `page_size ≤ 0.4 × min_supported_context_window`. Runtime clamps unsafe overrides with a warning.
- **List pagination** (separate concept) on search tools (`limit`/`offset`).

### Event bus and streaming

- **Observational pub/sub** [ADR-0003], not event-sourced state. Core control flow is sequential; events are an output of the orchestrator, not its input.
- **~20 event types** across categories: session, message, tool, skill, expert, context, storage, indexing.
- **Selective persistence**: durable for "what happened" events to an `event_log` table; transient for high-frequency streaming events (token deltas reconstructable from completed turns).
- **Transport**: WebSocket for the event stream (server → UI); REST for actions (UI → server: create session, send message, list profiles, manual load).
- **Hooks**: settings-defined event handlers (TS or shell), separate from the Skill system. Trusted, in-process.

### Error handling

- **Structured tool results**: success and failure share the tool channel. `ToolResult = { ok: true, value, metadata } | { ok: false, error: { code, message, recoverable, details } }`.
- **Error taxonomy**: `TOOL_VALIDATION`, `TOOL_RUNTIME`, `TOOL_TIMEOUT`, `PERMISSION_DENIED`, `RESOURCE_UNAVAILABLE`, `BUDGET_EXCEEDED`, `RATE_LIMITED`, `SKILL_LOAD_FAILED`.
- **Retry policy**: runtime auto-retries transient network errors (3x with exponential backoff). Everything else surfaces to the agent for semantic recovery.
- **Cancellation**: soft cancel checked between tool calls; hard cancel after 10s if a tool call is in flight.
- **Timeouts**: per-tool override; system default 10s.

### Slash commands

- **System Commands** (reserved names; bypass the model): `/new [profile]`, `/help`, `/load <skill>`, `/compact`, `/sessions`, `/clear`. Hard-coded in `src/server/commands/`, one TS module per command.
- **Skill commands**: declared by `slash_command` in SKILL.md frontmatter; collisions with system command names fail at startup. Skill command invocation loads the skill and forwards text as user message.

### Modules to build

- **EventBus** — pub/sub + selective persistence to `event_log`.
- **StorageAdapter** — abstraction over OneDrive mount / local folder / Graph; chosen via settings.
- **WikiEngine** — six wiki tools over StorageAdapter; maintains in-memory name→path index and (lazy) backlinks.
- **DocumentService** — extraction and pagination for the `system/documents` skill; per-format extractors.
- **SearchIndex** — FTS5 + sqlite-vec wrappers; `indexTurn`, `indexWikiPage`, `indexDoc`, `search*`.
- **ConversationStore** — repositories for `sessions`, `turns`, `tool_calls`, `event_log`.
- **SkillLoader** — discovers, parses, validates SKILL.md and CATEGORY.md; builds in-memory index; lazy-imports handlers.
- **SkillRegistry** — session-scoped tool registry; adds/removes tools as skills load/unload.
- **PermissionGate** — resolves base+child profiles; evaluates NACL-style allow/deny for skill loads and expert calls.
- **ProfileLoader** — loads and validates Agent and Model Profile YAMLs; composes inheritance.
- **Provider** — interface + LM Studio and OpenRouter adapters; resolves a profile/role to a concrete provider/model.
- **ContextManager** — token counting, compression triggering, summary composition, truncation, archival.
- **PromptComposer** — pure function: assembles the static system message from base/profile/skills/categories.
- **Orchestrator** — the turn loop; coordinates ContextManager, Provider, SkillRegistry, EventBus.
- **SystemCommandRegistry** — maps system command names to handlers.
- **CancellationManager** — soft+hard cancel tokens per turn.
- **HookRunner** — settings-driven event handlers.
- **HTTP/WS Server** — REST API + WebSocket transport.

---

## Testing Decisions

**Test philosophy.** Tests target external behavior (observable inputs → outputs and observable side effects), not implementation. A good test states a contract the module promises and would still pass under a reasonable refactor. Specifically: tests should not pin internal method names, internal sequencing, or implementation-private state.

**Test scope for v1**: the core deep modules. Integration and end-to-end tests are noted but deferred until the modules they would exercise are stable.

### Modules with tests

1. **PermissionGate** — given a `_base` profile and a child profile, assert that the NACL union (allow ∪ minus deny ∪) yields the expected verdict for representative cases: explicit allow, glob allow, allow-then-deny, deny precedence over allow, inherited deny that child cannot lift. Pure logic; no fixtures needed beyond constructed profile objects.
2. **ContextManager** — given a fake Provider (deterministic compressor) and a sequence of turns, assert: (a) compression fires only at the 80% threshold; (b) the summary ends with the recoverability hint; (c) the recency window of K=6 turns is preserved verbatim; (d) tool calls from the compressed region appear in the summary's tool log; (e) oversized tool results are truncated to head+tail+reference; (f) compression failure falls back to truncation without aborting the turn. Use fake providers and an in-memory store.
3. **PromptComposer** — pure function. Given fixed base prompt, profile, skill list, category list, assert the composed system message is byte-exact across a snapshot test. Snapshot updates require an explicit reviewer-approved change.
4. **SkillLoader** — frontmatter validation against the locked Zod schema. Assert: (a) missing `name` or `description` rejects with a clear error; (b) declared `tools[].handler` paths must exist; (c) `allowed-tools` listing nonexistent tools fails at load; (d) `slash_command` collision with reserved names fails at load; (e) skill discovery returns the expected index for a fixture directory.
5. **WikiEngine** — against an in-memory `StorageAdapter` fake. Assert: (a) `wiki_write` then `wiki_read` round-trips content and frontmatter; (b) `[[Name]]` resolves to the correct path via the name index; (c) `wiki_append` and `wiki_edit` preserve unaffected content; (d) `wiki_backlinks` returns pages that link to the target; (e) `wiki_search` ranks hits sensibly with FTS5 (test the integration, not the FTS internals).
6. **Provider adapters** — against mocked HTTP. For LM Studio and OpenRouter: assert tool-call request/response shape conforms to the `Provider` interface; streaming yields chunks in order; retries fire on transient errors and stop after 3 attempts; non-transient errors surface immediately.

### Prior art

This is a greenfield TypeScript project; there is no in-repo prior art. Conventions to adopt:

- **Vitest** as the test runner (fast, ESM-native, TypeScript-friendly).
- One test file per source module, colocated as `module.test.ts`.
- Fakes (in-memory implementations of interfaces) preferred over mocks (call-site spies). E.g. a `MemoryStorageAdapter` for WikiEngine tests rather than mocking individual filesystem calls.
- Snapshot tests for prompt composition only; everywhere else, write explicit assertions.

### Not tested in v1

- Orchestrator (covered indirectly by integration tests once subsystems stabilize).
- StorageAdapter concrete implementations (OneDrive mount, Graph) — too environment-dependent for v1 unit testing.
- HTTP/WS Server (covered by future end-to-end tests).
- DocumentService extraction pipelines (PDF/Office) — defer until specific extractors are chosen and their failure modes understood.

---

## Out of Scope

The following are deliberately deferred. They are not architectural debt; they are recognized future work with explicit rationale for not doing them now.

- **Sub-agents (`spawn_agent`)**. A separate primitive with its own lifecycle, context-passing rules, and return semantics. `consult_expert` remains strictly Q&A.
- **Worker-thread isolation for skill code**. The trust model is "skills are hand-written and trusted." Revisit if/when third-party skill loading becomes a goal.
- **MCP server consumption**. Out until there's a concrete external MCP server worth integrating.
- **OpenAPI-driven skills as a first-class skill type**. If needed, write a generic OpenAPI-client skill; do not bake codegen into the skill loader.
- **OCR / vision pipeline** for image and scanned-PDF content. Adapter slot exists in DocumentService; implementation deferred.
- **Multi-user concurrency / real-time SharePoint collaboration**. AgentOne is single-user; the storage layer reflects that.
- **Mobile UI**. Browser UI is the primary surface; mobile-responsive styling is welcome but not a v1 goal.
- **Webhook-based SharePoint change notification**. OneDrive sync + filesystem watcher are sufficient; webhooks add real engineering for marginal benefit.
- **Comprehensive UI screens beyond chat**. A skill browser and session list are in v1; settings UI, profile editor, hook editor are future work (settings.yaml files are the v1 interface).
- **Cross-machine session sync** beyond what OneDrive does for files. SQLite is local-only in v1.

---

## Further Notes

### Recommended build order

1. Spine: event bus, SQLite, REST + WS server, base prompt loader, minimal UI that round-trips one message via LM Studio. No skills yet.
2. Provider layer + Model Profile system: `Provider` interface, LM Studio adapter, Model Profile YAMLs with Roles.
3. Context Manager: token counting, 60/80 rules, compressor invocation, archival.
4. Sessions + persistence: `sessions`/`turns`/`tool_calls`/`event_log` tables. Resume.
5. Storage adapter: interface + `LocalFolderAdapter` first; `OneDriveMountAdapter` second.
6. Wiki Core Tools: six tools against the storage adapter; backlinks lazy at first.
7. Skill loader + permission gate: frontmatter validation, in-memory index, `list_skills` / `load_skill` Core Tools. `_base` profile with `system/filesystem`, `system/shell`, `system/web`, `system/memory`.
8. Search infrastructure: FTS5 over `turns` and wiki; `search_history` and `wiki_search`.
9. System commands + slash autocomplete: `/new`, `/help`, `/load`, `/compact`, `/sessions`, `/clear`.
10. OpenRouter adapter + `consult_expert`: budgets enforced per profile.
11. `system/documents` skill: paginated `doc_read` + `doc_search`; PDF first, Office next, binaries metadata-only.
12. Embeddings + sqlite-vec: local `nomic-embed-text` via LM Studio; index wiki + conversations.
13. Hooks: settings-based event handlers.
14. First non-system skill: prove the end-to-end loop.

Each step ships a working system. A demoable build exists from step 4.

### Domain language

The complete glossary is in [`CONTEXT.md`](../CONTEXT.md). Key terms used throughout this PRD include: Skill, SKILL.md, Category, Default Skill, Core Tool, Agent Profile, Base Profile, Model Profile, Role, Provider Tier, Expert, Wiki, Document, Drafts, Conversation History, Hook, Slash Command, System Command.

### Roadmap beyond V1

V2 turns AgentOne from "a chat-driven local agent with memory" into a
desk-side operations app — adding email triage, project management,
estimate/proposal generation, and QBO-integrated invoicing — without
shrinking the agent's role. The plan introduces a second extensibility
primitive (**Module**) alongside Skill, opens module services to non-chat
callers (HTTP, hooks, schedulers), and adds spawned sessions / notifications
so work can begin and surface attention from outside chat.

See [`./planning/v2-business-flow.md`](./planning/v2-business-flow.md) for the
full plan and build order.

### Architectural records

- [ADR-0001](./adr/0001-skill-system-as-primary-extensibility.md) — Skill system as primary extensibility; Core Tools are architectural only.
- [ADR-0002](./adr/0002-three-tree-storage-layout.md) — Three-tree storage layout on SharePoint.
- [ADR-0003](./adr/0003-event-bus-is-observational.md) — Event bus is observational, not control flow.
- [ADR-0004](./adr/0004-modules-as-second-extensibility-primitive.md) — Modules as a second extensibility primitive; open service surface; audit log.
- [ADR-0005](./adr/0005-non-chat-session-activation.md) — Non-chat session activation: spawned sessions, awaiting-input, notifications.
- [ADR-0006](./adr/0006-frontend-shell-architecture.md) — Frontend shell: chat-as-route with notification-mediated cross-page awareness.
- [ADR-0007](./adr/0007-module-panel-conventions.md) — Module panel conventions: dynamic actions, inline agent feedback, scoped views.

### Trust and threat model (single-user, local)

- Skills are trusted: they ship as TypeScript modules running in the main Node process. The permission system gates the *model's* ability to load them; it does not contain a malicious skill author. Operators install only skills they trust.
- Hooks are similarly trusted; they run on every matching event.
- Expert calls send curated context to OpenRouter; the local model decides what's shared. Operators should be aware: anything passed to `consult_expert` leaves the machine.
- Documents in `projects/` are read by the agent and may be passed to experts; the agent's recall heuristic (in `system/memory`) should be aware.

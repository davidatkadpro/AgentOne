# Phase 2 — Projects panel punch list

Trackable breakdown of the Projects panel work called for in [v2-business-flow.md#modulesprojects](./v2-business-flow.md#modulesprojects) and the implementation-level spec at [`./phase-2-projects-impl-spec.md`](./phase-2-projects-impl-spec.md). This punch list assumes Phase 1.5 has shipped (shell, shared module components, action discovery endpoint).

Last reviewed: 2026-05-23.

---

## Conventions

- **Status**: ☐ todo · ◐ in progress · ☑ done · ⊘ blocked
- **Depends on**: lists item IDs that must land first.
- **Done means**: the acceptance criteria are met and (where applicable) integration tests pass.

---

## Status overview

| Group | Done | In progress | Todo |
|---|---|---|---|
| P0 Backend route gaps (P2P1-P2P12) | 12 | 0 | 0 |
| P1 List + Create (L1-L4) | 4 | 0 | 0 |
| P2 Detail shell (D1-D3) | 3 | 0 | 0 |
| P3 Tasks tab (T1-T6) | 6 | 0 | 0 |
| P4 Single-module tabs (V1-V4) | 4 | 0 | 0 |
| P5 Cross-module placeholders (X1-X3) | 3 | 0 | 0 |
| P6 Polish + agent QA (Q1-Q3) | 3 | 0 | 0 |
| **Total** | **35** | **0** | **0** |

---

## P0 — Backend route gaps (must land before frontend can render real data)

### P2P1. Alias `/api/v1/projects/*` → `/api/projects/*`
**Status**: ☑ · **Depends on**: —
- Either add `/api/projects/*` aliases to the existing handlers in [`modules/projects/src/routes.ts`](../../modules/projects/src/routes.ts), or migrate handlers to the new path with a deprecation alias on `/api/v1/`.
- ADR-0007 convention is `/api/<module>/<entity>`; Phase 1.5 already shipped `/api/<module>/actions` under that scheme — Projects should follow.
- **Acceptance**: `curl /api/projects` returns the same shape as `curl /api/v1/projects`. Existing v1 tests still pass.

### P2P2. `PATCH /api/tasks/:id`
**Status**: ☑ · **Depends on**: P2P1
- Body: any subset of `{ title, description, status, assigneeProfile, parentTaskId }`. Returns the updated `{ task }`.
- Emits `task.updated` (or `task.completed` / `task.blocked` when status crosses those boundaries) on the bus; audit row with `module: 'projects'`, `action: 'task.update'`, `projectId`.
- **Acceptance**: integration test patches title and status; both reflected in `GET /api/projects/:id`; events fire with correct types.

### P2P3. `PATCH /api/phases/:id`
**Status**: ☑ · **Depends on**: P2P1
- Body: `{ name?, status?, position? }`. Returns the updated phase. Reordering via `position` triggers an internal re-pack so positions stay dense.
- **Acceptance**: rename + status transition + reorder all work; events `phase.updated` / `phase.completed` fire.

### P2P4. Dependency routes
**Status**: ☑ · **Depends on**: P2P1
- `POST /api/tasks/:id/dependencies` — body `{ dependsOnTaskId }`. Returns `{ dependency }`. 409 `TASK_DEPENDENCY_CYCLE` when the addition would create a cycle (service already throws `TaskDependencyCycleError`).
- `DELETE /api/tasks/:id/dependencies/:dependsOnTaskId` — 200 `{ ok: true }`.
- `GET /api/projects/:id` response gains a `dependencies: TaskDependency[]` field listing all deps for tasks in the project.
- **Acceptance**: round-trip add → list → delete works; cycle attempt returns 409.

### P2P5. `audit_log.project_id` migration + Audit service signature
**Status**: ☑ · **Depends on**: —
- Schema: nullable `project_id TEXT` column on `audit_log` + partial index `idx_audit_log_project ON audit_log (project_id, ts DESC) WHERE project_id IS NOT NULL` (specced in [v2-business-flow.md#audit-log](./v2-business-flow.md#audit-log)).
- `audit.write()` gains optional `projectId?: string`. The Projects service updates its existing audit calls to pass `projectId` for project/phase/task mutations.
- **Acceptance**: Projects' existing tests still pass with the new column; new test asserts `project_id` is populated on `project.create`, `phase.add`, `task.add`, `task.update`.

### P2P6. `GET /api/projects/:id/activity`
**Status**: ☑ · **Depends on**: P2P5
- Query: `?limit=50&offset=0`. Returns `{ entries: ActivityEntry[], hasMore: boolean }` where `ActivityEntry` is `{ id, ts, actorKind, actorId, module, action, targetId, details }`.
- SQL: `SELECT … FROM audit_log WHERE project_id = ? ORDER BY ts DESC LIMIT ? OFFSET ?`. Uses the partial index from P2P5.
- **Acceptance**: returns the project's audit history; pagination works.

### P2P7. `GET /api/projects/:id/scope`
**Status**: ☑ · **Depends on**: P2P1
- Resolves `<storageRoot>/<folderPath>/in/<newest-mtime>/scope.md` and returns `{ path, markdown, generatedAt }`. Returns `{ path: null, markdown: null }` when no scope file exists yet (typical pre-Phase-3).
- **Acceptance**: returns markdown for a planted scope file; returns null fields when none planted; 404 only on unknown project id.

### P2P8. `GET /api/projects/:id/files`
**Status**: ☑ · **Depends on**: P2P1
- Returns `{ rootPath, entries: Array<{ relativePath, name, kind, bytes, mtime }> }`. Walks `<projectFolder>/in/` and `<projectFolder>/drafts/` one level deep (deeper folders shown but not expanded).
- `rootPath` is the absolute path for the `Open folder` link.
- **Acceptance**: returns the in/ and drafts/ contents for a project with files planted; returns empty `entries` when none exist; 404 only on unknown project id.

### P2P9. `GET /api/projects/:id/budget`
**Status**: ☑ · **Depends on**: P2P1
- Returns `{ projectId, budgetCents, invoicedCents, paidCents, draftCents }`. Backed by the `project_budget` SQL view (Phase 5 wires the view properly; Phase 2 returns zeros when no invoices exist).
- **Acceptance**: returns zeroed budget for a project with no invoices; updated when invoicing module adds invoices (test that part once Phase 5 lands).

### P2P10. `GET /api/projects/next-number`
**Status**: ☑ · **Depends on**: P2P1
- Returns `{ number: string }` — server-suggested next `YY###` (current year + monotonically-increasing index past the highest existing `YY###` for that year).
- **Acceptance**: returns `25001` when no projects exist for the current year; `25002` after `25001` is created; respects manually-set non-sequential numbers (skips over them).

### P2P11. Cross-module event payloads carry `projectId`
**Status**: ☑ · **Depends on**: —
- Audit Phase 3-5 events (`email.filed`, `proposal.*`, `invoice.*`, `payment.recorded`) — every event that ties to a project carries `projectId` in the payload so the WS dispatcher can invalidate `projects.detail(projectId)` on those events.
- **Acceptance**: WS payloads for the cross-module events include `projectId` and the dispatch fanout invalidates `projects.detail`.

### P2P12. `module.reloaded` event on skill folder mtime change
**Status**: ☑ · **Depends on**: —
- The Phase 1.5 action-discovery cache is keyed on `skillsDir` mtime — already invalidates on file changes. This task adds a bus event `module.reloaded` emitted from the same code path, so the frontend can refetch `useModuleActions(moduleName)` on a hot-reload signal.
- **Acceptance**: dropping a new SKILL.md folder fires `module.reloaded` on the bus; React tray's action menu refreshes without page reload.

---

## P1 — List + Create

### L1. `/projects` list route + ModulePanel shell
**Status**: ☑ · **Depends on**: P2P1
- Replace the empty `ProjectsRoute.tsx` stub with `<ModulePanel>` wrapping `<KpiStrip>` + the project list.
- Search box (client-side filter by `number` or `name`); default filter `status in (pending, active, blocked)` with a "Show completed" toggle that adds `completed` + `cancelled`.
- Sort by last activity desc (client-side, derived from `updatedAt`).
- **Acceptance**: list renders rows from `GET /api/projects`; filter + search work; empty state appears when no projects exist.

### L2. ProjectListRow + status badge + budget mini-bar
**Status**: ☑ · **Depends on**: L1, P2P9
- Dense row: `number`, `name + client` (2-line cell), `<ProjectStatusBadge>`, `<BudgetMiniBar>`, last-activity timestamp.
- Row click navigates to `/projects/:id`.
- Budget bar shows % invoiced; hidden when `budgetCents` is null. Tone: amber when % > 90, danger when > 100.
- **Acceptance**: visual parity with the spec mockup; budget bar tones match the threshold rules.

### L3. KPI strip with clickable filter pills
**Status**: ☑ · **Depends on**: L1
- `<KpiStrip>` above the list. Pills: `Active` (status=active count), `Blocked` (status=blocked), `Awaiting invoice` (active projects with no draft/issued invoice — needs Phase 5 to populate properly, returns 0 until then), `Overdue` (invoice past due date — same Phase 5 gate).
- Clicking a pill filters the list; URL becomes `?filter=<pillId>`.
- **Acceptance**: pill counts match the list; clicking applies the filter and updates the URL; deep-linking the URL pre-selects the pill.

### L4. New-project dialog
**Status**: ☑ · **Depends on**: L1, P2P10
- `<NewProjectDialog>` triggered from a `+ New project` button in the header of the list.
- Fields: `number` (pre-filled from `GET /api/projects/next-number`, editable, must be unique — server returns 409 `DUPLICATE_PROJECT_NUMBER` if not), `name`, `client?`, `description?`.
- Submit calls `POST /api/projects`, navigates to `/projects/<new-id>` on success.
- Phase-template dropdown defaults to `Empty` with one option `AEC standard (SD/DD/CD/CA)` that creates four phases server-side post-create (template lookup deferred until phase-templates skill exists; for now `AEC standard` triggers four `POST /api/projects/:id/phases` calls).
- **Acceptance**: creating a project lands the user on its detail route; duplicate number surfaces inline as a field error.

---

## P2 — Detail shell

### D1. `/projects/:projectId` route + tab shell
**Status**: ☑ · **Depends on**: L1
- New `ProjectDetailRoute.tsx` that fetches `GET /api/projects/:id` (includes phases + tasks + dependencies) and `GET /api/projects/:id/budget`.
- Tab strip below the header; URL syncs via `?tab=<id>`.
- Empty tabs (everything except Tasks) render `<EmptyState>` until their content lands in P4/P5.
- **Acceptance**: deep-linking `/projects/<id>?tab=activity` opens the Activity tab; tab strip highlights match the URL.

### D2. ProjectHeaderStrip
**Status**: ☑ · **Depends on**: D1
- Renders `number · name · client · <ProjectStatusBadge> · budget rollup chip · "Open folder" · "Open in chat with project context"`.
- "Open folder" copies the absolute `rootPath` to clipboard (no `file://` link — Windows blocks them in modern browsers).
- "Open in chat with project context" calls `POST /api/sessions` with a `seed` that names the project (`Project ${number} — ${name}` as title; `Working on project ${number}` as initial message), then navigates to `/chat/<sessionId>`.
- Hosts `<StatusActionButton>` for the project status state machine (`pending → active → completed`, with `blocked` and `cancelled` in the overflow).
- **Acceptance**: header renders all metadata; status transitions persist via `PATCH /api/projects/:id/status`; "Open in chat" spawns a usable session.

### D3. ActionToolbar wired to `/api/projects/actions`
**Status**: ☑ · **Depends on**: D1
- The existing `<ActionToolbar>` (Phase 1.5 M1) goes in the header strip with `module="projects"`, `contextId=<project.id>`.
- Currently no projects skill declares `surface: 'action'`, so the toolbar renders empty until a skill author opts in. Per-tab `<AskAgentMenu>` covers the `ask_agent` surface.
- **Acceptance**: when a skill is edited to add `surface: 'action'`, dropping the file shows a button in the toolbar without a server restart (via P2P12's `module.reloaded` event).

---

## P3 — Tasks tab

### T1. Phase/task tree rendering
**Status**: ☑ · **Depends on**: D1
- `<TasksTab>` renders `useTaskTree(projectId)` rows. Phases at top level (always-expanded), tasks under phases (collapsible), subtasks under tasks (recursive).
- Empty project: auto-create the `Uncategorized` phase on first task add (server-side guard in `addTask` when no phases exist; service should grow this if it doesn't already).
- **Acceptance**: a project with 2 phases × 3 tasks × 1 subtask renders the right tree shape; expanding/collapsing nodes works.

### T2. Inline title rename + status popover
**Status**: ☑ · **Depends on**: T1, P2P2, P2P3
- Click the title on a phase or task → inline `<input>` for rename → blur or Enter saves via `PATCH /api/phases/:id` or `PATCH /api/tasks/:id`.
- Click the status badge → small popover lets the user pick a new status; saves on click.
- Optimistic UI: title/status updates immediately, rolls back on error.
- **Acceptance**: rename + status change persist; reverting on failed save works.

### T3. Add Phase / Add Task / Add Subtask buttons
**Status**: ☑ · **Depends on**: T1
- `+ Phase` at root, `+ Task` per phase, `+ Subtask` inline on a task.
- Each opens a small popover with `title` (and `phaseId` for task, `parentTaskId` for subtask). Submit POSTs to the matching endpoint, then refetches via cache invalidation.
- **Acceptance**: adding a phase, task, and subtask all work and appear in the tree.

### T4. Task dependencies popover
**Status**: ☑ · **Depends on**: T1, P2P4
- A `Dependencies` button on each task row opens a popover listing current deps + a picker to add a new one (searchable list of other tasks in the same project).
- Cycle attempts surface the 409 message inline ("Adding this dependency would create a cycle").
- A task whose `blockedBy[]` is non-empty shows a chip on the row: `Blocked on Task #14` (the position number of the blocker).
- **Acceptance**: add + remove deps work; cycle is rejected with a useful message; the `blocked on` chip appears when applicable.

### T5. Task Sheet drawer (deep-linkable)
**Status**: ☑ · **Depends on**: T1, P2P2
- Click anywhere on a task row → right-edge `<Sheet>` opens with `?task=<id>` in the URL. The tree stays visible behind the Sheet.
- Sheet body: description (markdown, editable via toggle), status, dependencies picker, subtasks list, attachments (files referenced from the task body — Phase 3 wires real files; pre-Phase-3 this is just a list of any "[path]" tokens in the description).
- Closing the Sheet (X, Esc, browser back) clears `?task=` from the URL.
- **Acceptance**: deep-linking `/projects/<id>?tab=tasks&task=<taskId>` opens the Sheet directly; back-button closes it.

### T6. Auto-create Uncategorized phase
**Status**: ☑ · **Depends on**: T3
- Server-side: when `addTask` is called and no phases exist, create a phase named `Uncategorized` and use its id.
- Frontend: when the user clicks `+ Task` on an empty project, the dialog skips the phaseId picker and just takes a title.
- **Acceptance**: a brand-new project + `+ Task` flow produces a single task under an `Uncategorized` phase.

---

## P4 — Single-module tabs (data is fully owned by Projects + storage)

### V1. ScopeTab
**Status**: ☑ · **Depends on**: D1, P2P7
- Fetches `GET /api/projects/:id/scope`. Renders the returned markdown via the same `<ReactMarkdown>` setup the chat uses.
- Empty state when no scope file exists ("No scope file yet. The email scope-extractor skill writes one to projects/<n>/in/<date>/scope.md.").
- Copy-path button for the resolved `path`.
- **Acceptance**: renders a planted scope file; empty state when none.

### V2. FilesTab
**Status**: ☑ · **Depends on**: D1, P2P8
- Fetches `GET /api/projects/:id/files`. Renders a two-column read-only tree (one column per top-level subfolder: `in/`, `drafts/`).
- Each row: filename, kind icon, size, mtime. Click-to-copy-path button per row.
- "Open folder" header link copies the absolute `rootPath`.
- **Acceptance**: lists files in `in/` and `drafts/`; copy-path actually copies; empty subfolders render an empty state.

### V3. DraftsTab
**Status**: ☑ · **Depends on**: D1
- Reuses the existing `GET /api/drafts` from Phase 1.5, filtering rows that mention the project's `number` in their `title` or `path`.
- Adds rows from `projects/<n>/drafts/` (already covered by FilesTab) but presents them in the draft-style row with note-count.
- **Acceptance**: drafts produced by auto_distill that reference the project appear here; project-local `drafts/` files appear too.

### V4. ActivityTab
**Status**: ☑ · **Depends on**: D1, P2P5, P2P6
- Fetches `GET /api/projects/:id/activity`. Renders a timeline of audit rows: `<RelativeTime>`, `actorKind`, `module.action`, target id, expand-to-see-`details`.
- Pagination: "Load older" button at the bottom when `hasMore`.
- WS subscriber invalidates `projects.activity(projectId)` on every event whose payload includes this `projectId`.
- **Acceptance**: creating a phase + task + status change all surface in Activity within a second (after `audit_log.write` returns).

---

## P5 — Cross-module placeholders (filled in by Phases 3-5)

### X1. EmailsTab placeholder
**Status**: ☑ · **Depends on**: D1
- Renders `<EmptyState>` with text "Email module wires in Phase 3 — emails filed to this project will appear here."
- Reserves the API shape: `GET /api/email?projectId=<id>` (to be wired in Phase 3).
- **Acceptance**: tab resolves; empty state visible; no broken request fires.

### X2. ProposalsTab placeholder
**Status**: ☑ · **Depends on**: D1
- Renders `<EmptyState>` ("Proposals module wires in Phase 4"). Same `GET /api/proposals?projectId=<id>` reservation.
- **Acceptance**: tab resolves; empty state visible.

### X3. InvoicesTab placeholder
**Status**: ☑ · **Depends on**: D1
- Renders `<EmptyState>` ("Invoicing module wires in Phase 5"). Same `GET /api/invoicing/invoices?projectId=<id>` reservation.
- **Acceptance**: tab resolves; empty state visible.

---

## P6 — Polish + agent QA

### Q1. Per-tab `<AskAgentMenu>`
**Status**: ☑ · **Depends on**: D1, P2P12
- Each tab footer (or header trailing edge) renders `<AskAgentMenu module="projects" tab={currentTab}>`.
- Examples per tab (Skills need to be authored — these are starter prompts):
  - Tasks: "Break down this phase into tasks", "Summarize what's blocked"
  - Scope: "Generate estimate from scope" (will spawn a Phase 4 build-estimate session)
  - Activity: "Summarise recent activity"
- Dispatched session id streams via `<InlineSessionStream>` collapsed above the tab content.
- **Acceptance**: at least 3 skills exist with `surface: 'ask_agent'` and `tabs: [...]`; clicking a menu item spawns a session and streams it inline.

### Q2. Status visual map applied everywhere
**Status**: ☑ · **Depends on**: L2, D2, T1
- Single `<ProjectStatusBadge>` component used by ProjectListRow, ProjectHeaderStrip, PhaseRow, TaskRow, TaskSheet, ActivityTab row details.
- Visual: matches the colour map in `phase-2-projects-impl-spec.md` §5.4. Strikethrough on completed, opacity on cancelled.
- **Acceptance**: changing the status anywhere reflects with the right colour and treatment everywhere it's shown.

### Q3. Optimistic mutation rollback + toast on error
**Status**: ☑ · **Depends on**: T2, T3, T4, T5
- All inline edits in the Tasks tab (rename, status, add/remove dep, sheet description edit) are optimistic. On error, the prior value is restored and a sonner toast surfaces the error message.
- **Acceptance**: simulating a failed `PATCH /api/tasks/:id` (e.g. injecting a 500) rolls back the title in the tree and shows a toast.

---

## Out of scope for Phase 2

- **Drag-and-drop reorder/reparent** for phases and tasks.
- **Custom phase templates beyond `Empty` and `AEC standard`** — templates land under `drafts/_templates/projects/<name>/` later.
- **Real Emails / Proposals / Invoices tab content** — Phases 3-5 own the data; X1/X2/X3 reserve the surface only.
- **QBO push integration** — Phase 5.
- **Multi-company support** — out per v2-business-flow.
- **Sub-agent spawning** — explicit deferral.

---

## Cross-references

- Impl spec (folder layout, types, prop signatures): [`./phase-2-projects-impl-spec.md`](./phase-2-projects-impl-spec.md)
- Domain spec: [`./v2-business-flow.md#modulesprojects`](./v2-business-flow.md#modulesprojects)
- Phase 1.5 prerequisites: [`./phase-1.5-react-punchlist.md`](./phase-1.5-react-punchlist.md), [`./phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md)
- ADRs: [`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md), [`../adr/0007-module-panel-conventions.md`](../adr/0007-module-panel-conventions.md)
- Server-side: [`../../modules/projects/`](../../modules/projects/)

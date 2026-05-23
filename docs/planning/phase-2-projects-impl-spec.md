# Phase 2 — Projects panel implementation spec

Implementation-level scaffolding for the Projects module's React panel. The module's domain spec (entities, business rules, skill list) lives in [`v2-business-flow.md`](./v2-business-flow.md#modulesprojects); this doc answers "how the code is wired" — folder layout, TypeScript types, TanStack Query cache keys, Zustand additions, component prop signatures, URL/tab schema, and the **backend route gaps** Phase 2 has to close before the panel can render.

Mirrors [`phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md). Read that first — this doc only adds what's specific to Projects.

Last reviewed: 2026-05-23. Treat as living.

---

## 0. Scope reminder

Phase 2 ships:
- The **Projects panel** (list + create + detail-as-hub with 8 tabs).
- The **Tasks tab** fully working (phase/task tree, status edits, dependencies, the task Sheet drawer).
- **Activity tab** working — depends on `audit_log.project_id` (Phase 2 prerequisite).
- **Scope, Files, Drafts tabs** working — read straight from disk via new server routes.
- **Emails, Proposals, Invoices tabs** render with empty states + a "Module not yet wired" hint. They get filled in by Phases 3-5 when those modules expose `?projectId=` filters.
- **`Ask agent ▾` menu** on every tab, filtered by the tab name via `<AskAgentMenu>` (P2S1 discovery from Phase 1.5 already runs against `modules/projects/skills/`).

Phase 2 does **not** ship: drag-to-reorder/reparent (deferred polish), the cross-module tab content (Emails/Proposals/Invoices — those land with their owning phase), or any new domain logic beyond the 7 skills already in `modules/projects/skills/`.

---

## 1. Folder layout

Extends `src/web/src/routes/modules/`. The empty `ProjectsRoute.tsx` stub from Phase 1.5 is replaced and expanded:

```
src/web/src/routes/modules/projects/
├── ProjectsRoute.tsx              # /projects — list view + KPI strip
├── ProjectDetailRoute.tsx         # /projects/:projectId — header + tabs shell
├── components/
│   ├── ProjectListRow.tsx         # dense row: number, name+client, status, budget bar, last activity
│   ├── ProjectStatusBadge.tsx     # used everywhere — colour map for the 5 statuses
│   ├── BudgetMiniBar.tsx          # inline % invoiced bar from project_budget view
│   ├── NewProjectDialog.tsx       # + New project modal
│   ├── ProjectHeaderStrip.tsx     # number · name · client · status · budget · folder link · "Open in chat"
│   └── tabs/
│       ├── TasksTab.tsx           # phase/task tree
│       ├── PhaseRow.tsx
│       ├── TaskRow.tsx            # recursive (subtasks via parentTaskId)
│       ├── TaskSheet.tsx          # right-edge Sheet, deep-linkable via ?task=:id
│       ├── ScopeTab.tsx           # renders projects/<n>/in/<date>/scope.md
│       ├── EmailsTab.tsx          # placeholder until Phase 3
│       ├── FilesTab.tsx           # read-only folder browser
│       ├── ProposalsTab.tsx       # placeholder until Phase 4
│       ├── InvoicesTab.tsx        # placeholder until Phase 5
│       ├── DraftsTab.tsx          # filtered drafts list
│       └── ActivityTab.tsx        # audit_log timeline
└── hooks/
    ├── useProjectDeepLink.ts      # ?task=<id>, ?tab=<id> URL helpers
    └── useTaskTree.ts             # flatten phases + tasks into render-ready rows
```

API hooks live alongside the existing ones:

```
src/web/src/api/
├── projects.ts                    # NEW — useProjects, useProject, useCreateProject, useUpdateStatus, …
└── …
```

**Pinned ordering rules** stay the same as the Phase 1.5 spec — no React in `lib/`, no fetching in `components/`, all routes own their own data loading via `api/` hooks.

---

## 2. TypeScript types

Add to `src/web/src/types/domain.ts`:

```ts
export type EntityStatus = 'pending' | 'active' | 'blocked' | 'completed' | 'cancelled'

export interface Project {
  id: string
  number: string
  name: string
  client: string | null
  description: string | null
  status: EntityStatus
  folderPath: string | null
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface Phase {
  id: string
  projectId: string
  name: string
  position: number
  status: EntityStatus
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface Task {
  id: string
  projectId: string
  phaseId: string
  parentTaskId: string | null
  title: string
  description: string | null
  status: EntityStatus
  assigneeProfile: string | null
  position: number
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface TaskDependency {
  taskId: string
  dependsOnTaskId: string
}

/** Read-model row from the `project_budget` SQL view (Phase 5 wires it for
 *  real; Phase 2 reads it returning zeros when no invoices exist). */
export interface ProjectBudget {
  projectId: string
  budgetCents: number | null
  invoicedCents: number
  paidCents: number
  draftCents: number
}

export interface ActivityEntry {
  id: number
  ts: number
  actorKind: 'agent' | 'http' | 'hook' | 'scheduler' | 'module'
  actorId: string | null
  module: string
  action: string
  targetId: string | null
  details: Record<string, unknown>
}
```

Mirror these exactly against [`modules/projects/src/service.ts`](../../modules/projects/src/service.ts). The Status enum literally matches.

### REST request/response types (`src/web/src/types/api.ts` additions)

```ts
// GET /api/projects
export interface ListProjectsResponse { projects: Project[] }
export interface ListProjectsQuery {
  status?: EntityStatus | EntityStatus[]
  limit?: number
}

// POST /api/projects
export interface CreateProjectRequest {
  number: string
  name: string
  client?: string
  description?: string
  folderPath?: string
  metadata?: Record<string, unknown>
}
export interface CreateProjectResponse { project: Project }
// 409 — { error: 'DUPLICATE_PROJECT_NUMBER', message, number }

// GET /api/projects/:id  — includes phases + tasks in one shot
export interface ProjectDetailResponse {
  project: Project
  phases: Phase[]
  tasks: Task[]
  dependencies: TaskDependency[]
}

// PATCH /api/projects/:id/status
export interface UpdateProjectStatusRequest { status: EntityStatus }
export interface UpdateProjectStatusResponse { project: Project }

// POST /api/projects/:id/phases
export interface AddPhaseRequest { name: string; metadata?: Record<string, unknown> }
export interface AddPhaseResponse { phase: Phase }

// POST /api/projects/:id/tasks
export interface AddTaskRequest {
  phaseId: string
  title: string
  description?: string
  parentTaskId?: string
  assigneeProfile?: string
  metadata?: Record<string, unknown>
}
export interface AddTaskResponse { task: Task }

// PATCH /api/tasks/:id  — NEW
export interface UpdateTaskRequest {
  title?: string
  description?: string | null
  status?: EntityStatus
  assigneeProfile?: string | null
  parentTaskId?: string | null
}
export interface UpdateTaskResponse { task: Task }

// PATCH /api/phases/:id  — NEW
export interface UpdatePhaseRequest {
  name?: string
  status?: EntityStatus
  position?: number
}
export interface UpdatePhaseResponse { phase: Phase }

// POST /api/tasks/:id/dependencies  — NEW
export interface AddDependencyRequest { dependsOnTaskId: string }
export interface AddDependencyResponse { dependency: TaskDependency }
// 409 — { error: 'TASK_DEPENDENCY_CYCLE', taskId, dependsOnTaskId }

// DELETE /api/tasks/:id/dependencies/:dependsOnTaskId  — NEW
export interface RemoveDependencyResponse { ok: true }

// GET /api/projects/:id/scope  — NEW
export interface ProjectScopeResponse {
  path: string | null              // e.g. "projects/24001 - Riverside/in/241108 - rfi/scope.md"
  markdown: string | null          // file contents, or null when missing
  generatedAt: string | null       // mtime ISO
}

// GET /api/projects/:id/files  — NEW
export interface ProjectFilesResponse {
  rootPath: string                 // absolute, for the "Open folder" link
  entries: Array<{
    relativePath: string
    name: string
    kind: 'file' | 'directory'
    bytes: number
    mtime: string
  }>
}

// GET /api/projects/:id/budget  — NEW (reads project_budget view)
export type ProjectBudgetResponse = ProjectBudget

// GET /api/projects/:id/activity  — NEW
export interface ProjectActivityQuery { limit?: number; offset?: number }
export interface ProjectActivityResponse {
  entries: ActivityEntry[]
  hasMore: boolean
}
```

> Note: the v1 contract uses `/api/v1/projects` — this spec assumes the routes are aliased to `/api/projects` (matches the ADR-0007 convention and how the rest of the v2 panels are wired). Tracked as P2P1 in the punch list.

---

## 3. TanStack Query cache keys

Extend `lib/query-client.ts`:

```ts
export const queryKeys = {
  // … existing …
  projects: {
    all: () => ['projects'] as const,
    list: (opts?: { status?: EntityStatus[] }) =>
      ['projects', 'list', opts?.status ?? null] as const,
    detail: (id: string) => ['projects', 'detail', id] as const,
    budget: (id: string) => ['projects', 'budget', id] as const,
    scope: (id: string) => ['projects', 'scope', id] as const,
    files: (id: string) => ['projects', 'files', id] as const,
    activity: (id: string, opts?: { offset?: number }) =>
      ['projects', 'activity', id, opts?.offset ?? 0] as const,
  },
  tasks: {
    all: () => ['tasks'] as const,
    detail: (id: string) => ['tasks', 'detail', id] as const,
  },
} as const
```

**Mutation → invalidation:**

| Mutation | Invalidates |
|---|---|
| `useCreateProject` | `projects.list()`, `projects.all()` |
| `useUpdateProjectStatus(id)` | `projects.list()`, `projects.detail(id)`, `projects.activity(id)` |
| `useAddPhase(projectId)` | `projects.detail(projectId)`, `projects.activity(projectId)` |
| `useAddTask(projectId)` | `projects.detail(projectId)`, `projects.activity(projectId)` |
| `useUpdateTask(taskId)` | `projects.detail(<owning projectId>)`, `tasks.detail(taskId)` |
| `useUpdatePhase(phaseId)` | `projects.detail(<owning projectId>)` |
| `useAddDependency(taskId)` | `projects.detail(<owning projectId>)` |
| `useRemoveDependency(taskId)` | `projects.detail(<owning projectId>)` |

**WS → cache invalidation** (add to the §3 table in [phase-1.5-frontend-impl-spec.md](./phase-1.5-frontend-impl-spec.md)):

| Event | Invalidates |
|---|---|
| `project.created`, `project.updated`, `project.completed` | `projects.list()`; `projects.detail(projectId)` if known |
| `phase.created`, `phase.completed` | `projects.detail(projectId)`, `projects.activity(projectId)` |
| `task.created`, `task.updated`, `task.completed`, `task.blocked` | `projects.detail(projectId)`, `tasks.detail(taskId)`, `projects.activity(projectId)` |

The dispatch fanout (`lib/ws.ts` `invalidateForEvent`) gets these new branches.

**Stale times**:
- `projects.list()`: 30s (default).
- `projects.detail(id)`: 30s default + invalidation on every project/phase/task event for that project.
- `projects.budget(id)`: 60s — depends on Invoicing module events not yet flowing.
- `projects.scope(id)`: 5 min — file rarely changes; user can manually refresh.
- `projects.activity(id, offset)`: 30s; explicit refetch on visible.

---

## 4. Zustand additions

No new global store. Phase 2 adds two **derived** read-only hooks on top of TanStack Query data — no WS-driven mutable state beyond what the existing `session-stream` store already handles (the tasks tab updates through React Query refetch on `task.*` events, not a separate atom).

### 4.1 `useTaskTree(projectId)` — `hooks/useTaskTree.ts`

Flattens phases + tasks + parentTaskId chains into a render-ready row list:

```ts
export interface TaskTreeRow {
  kind: 'phase' | 'task'
  id: string
  parentId: string | null         // phaseId for task, null for phase
  depth: number                   // 0 for phase, 1 for task, 2+ for subtasks
  status: EntityStatus
  title: string                   // phase.name or task.title
  position: number
  childCount: number
  blockedBy: string[]             // task ids if blocked by deps
}

export function useTaskTree(projectId: string): {
  rows: TaskTreeRow[]
  isLoading: boolean
  refetch: () => void
}
```

Memoised against the `projects.detail` query data. Sorts: phases by position, tasks by position within phase, subtasks recursively. The `blockedBy` field is computed from `dependencies[]` in the detail payload — a task whose `dependsOnTaskId` is not `completed` gets that id listed.

### 4.2 `useProjectDeepLink(projectId)` — `hooks/useProjectDeepLink.ts`

Reads/writes `?tab=` and `?task=` search params, returning typed setters:

```ts
type ProjectTab = 'tasks' | 'scope' | 'emails' | 'files' | 'proposals' | 'invoices' | 'drafts' | 'activity'

export function useProjectDeepLink(projectId: string): {
  tab: ProjectTab
  setTab(tab: ProjectTab): void
  taskId: string | null
  setTaskId(id: string | null): void
  open(taskId: string): void
  close(): void
}
```

Default tab is `'tasks'`. `setTab` and `setTaskId` use `replace` navigation so back/forward don't accumulate history entries.

---

## 5. Component prop signatures

### 5.1 List route

```ts
// ProjectsRoute.tsx — mounted at /projects
// No props (reads from useSearchParams for filter).

// components/ProjectListRow.tsx
interface ProjectListRowProps {
  project: Project
  budget: ProjectBudget | null     // null when budget data hasn't loaded yet
  lastActivity: number | null      // ms epoch; null when no activity yet
  isActive: boolean
}

// components/BudgetMiniBar.tsx
interface BudgetMiniBarProps {
  invoicedCents: number
  budgetCents: number | null       // null = no budget set → bar hidden
}

// components/ProjectStatusBadge.tsx
interface ProjectStatusBadgeProps {
  status: EntityStatus
  size?: 'sm' | 'md'
}

// components/NewProjectDialog.tsx
interface NewProjectDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  suggestedNumber: string          // server-computed next YY###
}
```

### 5.2 Detail route + header

```ts
// ProjectDetailRoute.tsx — mounted at /projects/:projectId
// No props (reads :projectId + ?tab= + ?task= from URL).

// components/ProjectHeaderStrip.tsx
interface ProjectHeaderStripProps {
  project: Project
  budget: ProjectBudget | null
  folderUrl: string | null         // file:// URL when folder_path exists
}
```

### 5.3 Tabs

```ts
// All tab components take the same minimal contract: the project id, owning
// status, and any tab-specific filter from the URL. They own their data
// fetching via api/ hooks — the detail route doesn't pre-fetch tab data.

interface TabProps { projectId: string }

// components/tabs/TasksTab.tsx — TabProps + the Sheet open state
interface TasksTabProps extends TabProps {
  openTaskId: string | null         // from ?task=:id
  onOpenTask(id: string | null): void
}

// components/tabs/TaskRow.tsx
interface TaskRowProps {
  row: TaskTreeRow                  // from useTaskTree()
  expanded: boolean
  onToggle(): void
  onSelect(): void
}

// components/tabs/TaskSheet.tsx
interface TaskSheetProps {
  taskId: string
  open: boolean
  onOpenChange(open: boolean): void
}

// components/tabs/ScopeTab.tsx, FilesTab.tsx, ActivityTab.tsx, DraftsTab.tsx
// All just `TabProps`. Each owns its query hook.

// components/tabs/EmailsTab.tsx, ProposalsTab.tsx, InvoicesTab.tsx
// All `TabProps`. Render `<EmptyState>` with "Module wires in Phase <n>"
// until their owning phase ships and the filter API lands. The shell is in
// place so swapping the content is a small diff.
```

### 5.4 Status enum → visual map (shared utility)

A single source of truth in `components/ProjectStatusBadge.tsx`:

```ts
const STATUS_STYLE: Record<EntityStatus, { label: string; tone: string }> = {
  pending:   { label: 'Pending',   tone: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  active:    { label: 'Active',    tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' },
  blocked:   { label: 'Blocked',   tone: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  completed: { label: 'Completed', tone: 'bg-zinc-100 text-zinc-500 line-through' },
  cancelled: { label: 'Cancelled', tone: 'bg-zinc-100 text-zinc-400 opacity-60' },
}
```

Used by ProjectListRow, ProjectHeaderStrip, PhaseRow, TaskRow, TaskSheet, ActivityTab. Same map across all of them per the v2-business-flow grilling decision.

### 5.5 Where the shared module components fit

| Component (from ADR-0007) | Where it lives in the Projects panel |
|---|---|
| `<ModulePanel>` | wraps the list view in `ProjectsRoute.tsx` |
| `<KpiStrip>` | top of `ProjectsRoute.tsx` — pills: Active · Blocked · Awaiting invoice · Overdue |
| `<ActionToolbar>` | header strip in `ProjectDetailRoute.tsx` — primary actions for `surface: 'action'` skills (currently empty; populated when a skill author adds `surface: action` to a SKILL.md) |
| `<AskAgentMenu>` | one per tab — pulls from `useModuleActions('projects')` with `tab={currentTab}` |
| `<StatusActionButton>` | header strip — wraps the project status transition. The `transitions` table is the project state machine (`pending → active → completed`, with `blocked` and `cancelled` as secondaries) |
| `<InlineSessionStream>` | rendered when an action dispatch returns a sessionId, collapsible block in the header area |

---

## 6. URL / tab schema

| Route | Search params |
|---|---|
| `/projects` | `?filter=<status>` (`pending,active,blocked` is default), `?completed=true` to show completed |
| `/projects/:projectId` | `?tab=tasks\|scope\|emails\|files\|proposals\|invoices\|drafts\|activity` (default `tasks`), `?task=<id>` (only meaningful with `tab=tasks` — opens the Sheet) |

**Deep-link cases the punch list pins:**
- `/projects?filter=blocked` — opens list filtered to blocked.
- `/projects/<id>?tab=tasks&task=<taskId>` — opens detail, Tasks tab, with the Sheet open on that task (back-button closes the Sheet).
- `/projects/<id>?tab=activity` — opens Activity tab; refetch invalidates on `audit_log` cache invalidation when the user is viewing.

---

## 7. Backend route gaps to close in Phase 2

The Projects backend ships `POST/GET/PATCH /api/v1/projects/*` already, but the panel needs more. Each item below is a small server task tracked in the Phase 2 punch list.

| # | Route | Reason |
|---|---|---|
| P2P1 | Alias `/api/v1/projects/*` → `/api/projects/*` (or normalise to no-v1 prefix everywhere) | Consistency with ADR-0007's `/api/<module>/<entity>` convention. Existing route handlers stay; new aliases land next to them |
| P2P2 | `PATCH /api/tasks/:id` | Inline edit task title/status/description/assignee/parent in the tree |
| P2P3 | `PATCH /api/phases/:id` | Inline rename phase, change status, set position |
| P2P4 | `POST /api/tasks/:id/dependencies` + `DELETE /api/tasks/:id/dependencies/:dependsOnTaskId` | Dependencies popover on a task row |
| P2P5 | `audit_log.project_id` schema migration + index + Audit service `write({…, projectId?})` signature | Activity tab's primary query is `WHERE project_id = ?`. Specced in [v2-business-flow.md#audit-log](./v2-business-flow.md#audit-log) — not yet implemented |
| P2P6 | `GET /api/projects/:id/activity?limit=&offset=` | Read audit_log rows for this project; pagination via offset |
| P2P7 | `GET /api/projects/:id/scope` | Resolve newest `projects/<n>/in/<dated>/scope.md` and return markdown |
| P2P8 | `GET /api/projects/:id/files` | Walk `projects/<n>/in/` and `projects/<n>/drafts/` one level; return entries + absolute root path |
| P2P9 | `GET /api/projects/:id/budget` | Project budget view query (returns zeros pre-Phase-5) |
| P2P10 | `GET /api/projects?` next-number suggestion (or a separate `GET /api/projects/next-number`) | New-project dialog needs the next `YY###` |
| P2P11 | `project_id` denormalised onto `email`, `proposal`, `invoice` event payloads (already on the entities) | Lets WS cache invalidation route cross-module events to the right project's queries |
| P2P12 | `module.reloaded` event emitted when a skill folder under `modules/projects/skills/` changes (mtime-based) | Invalidates the action-discovery cache without restart — backs the `<AskAgentMenu>` refresh on disk edits |

Items P2P11 + P2P12 are minor — the rest are real work but small (each ~1-2 hours).

---

## 8. Phasing within Phase 2

The punch list orders work so a useful slice ships at every halt:

1. **P0 — Backend route normalisation + missing routes** (P2P1-P2P5)
2. **P1 — List + Create** (`/projects`, NewProjectDialog, KPI strip, budget mini-bar)
3. **P2 — Detail shell** (header strip, tab routing, empty tabs)
4. **P3 — Tasks tab** (tree, status edits, dependencies, TaskSheet)
5. **P4 — Activity + Scope + Files + Drafts tabs** (single-module data)
6. **P5 — Cross-module tab placeholders** (Emails, Proposals, Invoices) — empty states only
7. **P6 — Polish + agent integration QA**

Each level is shippable on its own. The full set is ~6-9 days of focused work — more than the v2-business-flow's optimistic "~1 week" — because the audit_log migration + 8 tab routes weren't priced in there.

---

## 9. What this spec does NOT pin

- **Drag-and-drop reorder/reparent** for phases and tasks — deferred polish, requires picking a DnD library and a position-update protocol.
- **Phase templates beyond `Empty` and `AEC standard`** — future templates live under `drafts/_templates/projects/<name>/` and are not specced now.
- **Cross-module tab content** for Emails / Proposals / Invoices — those are Phase 3-5 deliverables. Phase 2 ships the empty containers.
- **QBO push integration** — Phase 5.
- **Multi-company support** — explicitly out per v2-business-flow.

---

## 10. Cross-references

- Phase 2 punch list (work breakdown): [`./phase-2-projects-punchlist.md`](./phase-2-projects-punchlist.md)
- Module domain spec: [`./v2-business-flow.md#modulesprojects`](./v2-business-flow.md#modulesprojects)
- Frontend shell ADR: [`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md)
- Module conventions ADR: [`../adr/0007-module-panel-conventions.md`](../adr/0007-module-panel-conventions.md)
- Phase 1.5 impl spec (prerequisite): [`./phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md)
- Server service: [`../../modules/projects/src/service.ts`](../../modules/projects/src/service.ts)
- Server routes: [`../../modules/projects/src/routes.ts`](../../modules/projects/src/routes.ts)

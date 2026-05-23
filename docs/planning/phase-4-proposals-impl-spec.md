# Phase 4 — Proposals panel implementation spec

Implementation-level scaffolding for the Proposals module's React panel (and the Project detail's Proposals tab). Domain spec: [`v2-business-flow.md#modulesproposals`](./v2-business-flow.md#modulesproposals). Mirrors [`phase-2-projects-impl-spec.md`](./phase-2-projects-impl-spec.md) and [`phase-3-email-impl-spec.md`](./phase-3-email-impl-spec.md) — read [`phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md) for the foundational conventions.

Last reviewed: 2026-05-24.

---

## 0. Scope reminder

Phase 4 ships:
- **Proposals panel** (`/proposals`) — a mixed rolling-artifact stream: estimates and proposals collapse into one row-per-artifact list with a continuous status workflow.
- **Detail view** (`/proposals/:id`) — 50/50 split: line-item editor on the left, rendered markdown preview on the right.
- **Generation flow** (`+ New proposal`) — template picker + two-tab dialog (Build from scope / Start blank).
- **Status state machine** — `Estimate · draft → ready` → `Proposal · issued → accepted | rejected | superseded`. Contextual primary button reflects the current state.
- **Pandoc-optional rendering** — markdown always saved; PDF/docx visible only when `GET /api/health` reports `capabilities.pandoc: true`.
- **Project Proposals tab** content — replaces the Phase 2 placeholder.
- **`scope-extractor` integration** — `Build from scope` reads `projects/<n>/in/<date>/scope.md` (produced by the Phase 3 skill).

Phase 4 does **not** ship: outbound email sending (no `send_proposal`), real-time collaboration, version diff visualisation between revisions, custom template editor in the UI (templates remain a folder + file edit).

---

## 1. Folder layout

```
src/web/src/routes/modules/proposals/
├── ProposalsRoute.tsx                # /proposals — mixed artifact list
├── ProposalDetailRoute.tsx           # /proposals/:id — split view
├── components/
│   ├── ArtifactListRow.tsx           # one row per estimate-or-proposal
│   ├── ArtifactStatusBadge.tsx       # combined Estimate · / Proposal · enum
│   ├── ProposalKpiStrip.tsx          # Drafts · Issued awaiting · Accepted this month
│   ├── NewProposalDialog.tsx         # template picker + Build-from-scope / Start-blank tabs
│   ├── EstimateEditor.tsx            # left pane: header + line-items table
│   ├── LineItemsTable.tsx            # inline-edit kind/desc/qty/unit/price
│   ├── ProposalPreview.tsx           # right pane: rendered markdown
│   ├── ProposalToolbar.tsx           # contextual primary action + ▾ More + Download
│   ├── HistoryPopover.tsx            # status timeline from audit_log + events
│   └── ReviseConfirmDialog.tsx       # creates new estimate with previous_estimate_id
└── hooks/
    ├── useArtifactStream.ts          # merges estimate + proposal into one render list
    └── useTemplates.ts               # GET /api/proposals/templates
```

Project-tab adapter:

```
src/web/src/routes/modules/projects/components/tabs/
├── ProposalsTab.tsx                  # replaces Phase 2 placeholder; filtered artifact list
```

API hooks:

```
src/web/src/api/
├── proposals.ts                      # NEW — useProposals, useEstimate, useCreateEstimate, …
└── proposals-templates.ts            # NEW — useTemplates
```

---

## 2. TypeScript types

Add to `src/web/src/types/domain.ts`:

```ts
export type EstimateKind = 'fixed' | 'time_and_materials' | 'unit'

export type EstimateStatus = 'draft' | 'ready' | 'accepted' | 'rejected' | 'superseded'
export type ProposalStatus = 'issued' | 'accepted' | 'rejected' | 'superseded'

export interface EstimateLine {
  id: string
  kind: EstimateKind
  description: string
  qty: number
  unit: string | null
  unitPriceCents: number
  /** Convenience server-computed value; clients still recompute on edits. */
  lineTotalCents: number
  position: number
  metadata: Record<string, unknown>
}

export interface Estimate {
  id: string
  projectId: string
  version: number
  previousEstimateId: string | null
  scopeFilePath: string | null         // e.g. "projects/24001/in/241108 - rfi/scope.md"
  status: EstimateStatus
  totalCents: number
  lines: EstimateLine[]
  templateName: string | null
  notes: string | null
  createdAt: number
  updatedAt: number
}

export interface Proposal {
  id: string
  number: string                       // e.g. "24001-P1"
  projectId: string
  estimateId: string
  status: ProposalStatus
  /** Newest first. Markdown is always present; pdfPath / docxPath only when Pandoc rendered them. */
  renderedFiles: Array<{ path: string; kind: 'md' | 'pdf' | 'docx'; mtime: string; bytes: number }>
  issuedAt: number | null
  acceptedAt: number | null
  rejectedAt: number | null
  supersededAt: number | null
  supersededByProposalId: string | null
  createdAt: number
  updatedAt: number
}

/** Flattened row used by the artifact list. The UI treats the
 *  estimate↔proposal pair as one continuous workflow. */
export interface ArtifactRow {
  kind: 'estimate' | 'proposal'
  id: string
  number: string                       // estimate id slug OR proposal number
  projectId: string
  projectNumber: string
  projectName: string
  status: EstimateStatus | ProposalStatus
  /** Combined status label e.g. "Estimate · draft" / "Proposal · issued". */
  displayStatus: string
  totalCents: number
  lastActivity: number
  source: 'from scope.md' | 'manual'
  scopeFilePath: string | null
}

export interface ProposalTemplate {
  name: string
  source: 'module' | 'override'        // override wins on name collision
  path: string                         // absolute, for display only
  description: string | null
}

export interface ArtifactHistoryEntry {
  ts: number
  actorKind: 'agent' | 'http' | 'hook' | 'scheduler' | 'module'
  module: string
  action: string                       // e.g. 'estimate.create', 'proposal.issue'
  fromStatus: string | null
  toStatus: string | null
  details: Record<string, unknown>
}
```

### REST request/response types

```ts
// GET /api/proposals/artifacts  — combined estimate + proposal list (top-level)
export interface ListArtifactsQuery {
  projectId?: string
  status?: string | string[]           // combined enum across estimate + proposal
  limit?: number
}
export interface ListArtifactsResponse { artifacts: ArtifactRow[] }

// GET /api/proposals/:id
//   :id resolves to either an estimate or proposal; the response carries both
//   when the proposal exists.
export interface ProposalDetailResponse {
  estimate: Estimate
  proposal: Proposal | null            // null when only the estimate exists
  predecessorEstimates: Estimate[]     // chain via previousEstimateId
}

// POST /api/projects/:projectId/estimates
export interface CreateEstimateRequest {
  scopeFilePath?: string | null
  templateName?: string
  lines?: Array<Omit<EstimateLine, 'id' | 'lineTotalCents' | 'position'>>
  notes?: string
}
export interface CreateEstimateResponse { estimate: Estimate }

// PATCH /api/estimates/:id
export interface UpdateEstimateRequest {
  status?: EstimateStatus
  templateName?: string
  notes?: string
  scopeFilePath?: string | null
  lines?: EstimateLine[]               // full replacement on edits
}
export interface UpdateEstimateResponse { estimate: Estimate }

// POST /api/estimates/:id/revise
export interface ReviseEstimateResponse { estimate: Estimate }  // new draft with previousEstimateId set

// POST /api/projects/:projectId/proposals
export interface CreateProposalRequest {
  estimateId: string
  templateName?: string                // defaults to estimate.templateName
}
export interface CreateProposalResponse { proposal: Proposal }

// PATCH /api/proposals/:id
export interface UpdateProposalRequest {
  status?: ProposalStatus
  supersededByProposalId?: string | null
}
export interface UpdateProposalResponse { proposal: Proposal }

// POST /api/proposals/:id/render
export interface RenderProposalRequest {
  formats: Array<'md' | 'pdf' | 'docx'>
}
export interface RenderProposalResponse {
  files: Proposal['renderedFiles']
  unavailable: Array<'pdf' | 'docx'>   // formats skipped because Pandoc isn't installed
}

// GET /api/proposals/templates  — NEW
export interface ListTemplatesResponse { templates: ProposalTemplate[] }

// GET /api/proposals/:id/history  — NEW
export interface ProposalHistoryResponse { entries: ArtifactHistoryEntry[] }

// GET /api/proposals/:id/download/:format  — NEW
//   Streams the rendered file with Content-Disposition: attachment.
//   404 if not yet rendered; 503 if format is requested but Pandoc unavailable.

// GET /api/projects/:id/scope-files  — NEW
//   Lists every scope.md under projects/<n>/in/<*>/ for the New Proposal dialog.
export interface ListScopeFilesResponse {
  files: Array<{ path: string; mtime: string; bytes: number }>
}
```

> Note: existing routes live under `/api/v1/projects/:projectId/estimates`, etc. Phase 4 normalises to a top-level `/api/proposals/*` namespace plus per-project nested routes (`/api/projects/:projectId/estimates`). Tracked as P4P1.

---

## 3. TanStack Query cache keys

```ts
export const queryKeys = {
  // … existing …
  proposals: {
    all: () => ['proposals'] as const,
    artifacts: (opts?: ListArtifactsQuery) => ['proposals', 'artifacts', opts ?? {}] as const,
    detail: (id: string) => ['proposals', 'detail', id] as const,
    history: (id: string) => ['proposals', 'history', id] as const,
    templates: () => ['proposals', 'templates'] as const,
    scopeFiles: (projectId: string) => ['proposals', 'scope-files', projectId] as const,
  },
  estimates: {
    detail: (id: string) => ['estimates', 'detail', id] as const,
  },
} as const
```

**Mutation → invalidation:**

| Mutation | Invalidates |
|---|---|
| `useCreateEstimate(projectId)` | `proposals.artifacts()`, `projects.detail(projectId)` |
| `useUpdateEstimate(id)` | `proposals.detail(<resolveDetailId>)`, `proposals.artifacts()`, `estimates.detail(id)` |
| `useReviseEstimate(id)` | `proposals.artifacts()`, `proposals.detail(<predecessor>)`, `projects.detail(projectId)` |
| `useCreateProposal(projectId)` | `proposals.artifacts()`, `projects.detail(projectId)` |
| `useUpdateProposal(id)` | `proposals.detail(id)`, `proposals.artifacts()`, `projects.detail(projectId)` |
| `useRenderProposal(id)` | `proposals.detail(id)` |

**WS → cache invalidation:**

| Event | Invalidates |
|---|---|
| `estimate.created`, `estimate.updated`, `estimate.accepted`, `estimate.rejected` | `proposals.artifacts()`, `proposals.detail(<id>)`, `estimates.detail(id)` |
| `proposal.created`, `proposal.issued`, `proposal.superseded` | `proposals.artifacts()`, `proposals.detail(<id>)`, `projects.detail(projectId)` if known |

---

## 4. Zustand additions

No new global store. The split-view's local state (which line is being edited, scroll sync between editor and preview) lives in component state.

Add a small derived hook `useArtifactStream(query)` that:
1. Reads `proposals.artifacts()` via TanStack Query.
2. Computes `displayStatus` for each row (`Estimate · draft`, `Proposal · issued`, etc.).
3. Sorts by `lastActivity` desc.
4. Returns `{ rows: ArtifactRow[], isLoading, error }`.

---

## 5. Component prop signatures

### 5.1 List route

```ts
// ProposalsRoute.tsx — mounted at /proposals
// No props. Reads ?filter= and ?project= from URL.

// components/ArtifactListRow.tsx
interface ArtifactListRowProps {
  row: ArtifactRow
  isActive: boolean
}

// components/ProposalKpiStrip.tsx
interface ProposalKpiStripProps {
  draftCount: number
  issuedAwaitingCount: number
  acceptedThisMonthCount: number
  activePillId: string | null
  onPillClick(id: string | null): void
}

// components/NewProposalDialog.tsx
interface NewProposalDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  defaultProjectId?: string             // pre-selected when launched from a project's Proposals tab
}
```

### 5.2 Detail route — 50/50 split

```ts
// ProposalDetailRoute.tsx — mounted at /proposals/:id
// No props. Reads :id from URL.

// components/EstimateEditor.tsx  (left pane)
interface EstimateEditorProps {
  estimate: Estimate
  readOnly: boolean                    // true when status is accepted/rejected/superseded
  onChange(updates: UpdateEstimateRequest): void
}

// components/LineItemsTable.tsx
interface LineItemsTableProps {
  lines: EstimateLine[]
  readOnly: boolean
  onLineChange(index: number, update: Partial<EstimateLine>): void
  onLineAdd(): void
  onLineRemove(index: number): void
}

// components/ProposalPreview.tsx  (right pane)
interface ProposalPreviewProps {
  estimateId: string
  proposalId: string | null            // null = preview from estimate only
  templateName: string | null
  /** When true, debounce auto-regenerate on estimate change. Defaults to true. */
  autoRegenerate?: boolean
}

// components/ProposalToolbar.tsx
interface ProposalToolbarProps {
  estimate: Estimate
  proposal: Proposal | null
  pandocAvailable: boolean
  onAction(action: ToolbarAction): void
}

type ToolbarAction =
  | { kind: 'mark-ready' }
  | { kind: 'issue' }
  | { kind: 'mark-accepted' }
  | { kind: 'mark-rejected' }
  | { kind: 'revise' }
  | { kind: 'supersede'; replacementProposalId?: string }
  | { kind: 'download'; format: 'md' | 'pdf' | 'docx' }
  | { kind: 'history' }
```

### 5.3 Status visual map

A combined status enum drives `<ArtifactStatusBadge>`:

| status | label | tone |
|---|---|---|
| `Estimate · draft` | yellow | edit-friendly |
| `Estimate · ready` | blue | reviewed, awaiting issuance |
| `Proposal · issued` | indigo | awaiting client response |
| `Proposal · accepted` | emerald | won |
| `Proposal · rejected` | rose | lost |
| `Proposal · superseded` | zinc, strikethrough | replaced by a later revision |
| `Estimate · rejected` | rose, muted | never made it to proposal |
| `Estimate · superseded` | zinc, strikethrough | replaced by a revised draft |

### 5.4 Where the shared module components fit

| Component (ADR-0007) | Where in Proposals |
|---|---|
| `<ModulePanel>` | wraps `ProposalsRoute.tsx` |
| `<KpiStrip>` | top of `ProposalsRoute.tsx` |
| `<StatusActionButton>` | toolbar — drives the state machine |
| `<ActionToolbar>` | toolbar — `surface: 'action'` proposals skills |
| `<AskAgentMenu>` | toolbar — `surface: 'ask_agent'` skills, no per-tab filter (detail view is a single page) |
| `<InlineSessionStream>` | rendered below the toolbar when `Build from scope` or `Revise` spawns a session |

---

## 6. URL schema

| Route | Search params |
|---|---|
| `/proposals` | `?filter=<status>`, `?project=<projectId>`, `?search=` |
| `/proposals/:id` | `?compare=<predecessorEstimateId>` (future polish — defer diff view) |
| `/projects/:id?tab=proposals` | inherits Phase 2 routing |

Deep-link cases:
- `/proposals?filter=draft` — opens list filtered to drafts
- `/proposals/<id>` — opens detail; if the id is an estimate's, the proposal pane shows `Not yet issued`
- `/proposals?project=<id>` — list filtered to one project (the project tab uses this format internally)

---

## 7. Backend route gaps to close

| # | Route | Reason |
|---|---|---|
| P4P1 | Alias `/api/v1/{projects/:pid/estimates,projects/:pid/proposals,estimates/:id,proposals/:id}/*` → de-versioned paths | ADR-0007 convention — symmetric with Phase 2/3 normalisation. Tests carry over |
| P4P2 | `GET /api/proposals/artifacts` (cross-project rolling stream) | New top-level endpoint — current routes are project-scoped only |
| P4P3 | `GET /api/proposals/:id` returns `{ estimate, proposal, predecessorEstimates }` | Unify the detail endpoint so the split view loads in one round-trip |
| P4P4 | `POST /api/estimates/:id/revise` | Creates a new estimate (`previousEstimateId = :id`, `status: 'draft'`, status of old estimate unchanged); returns the new estimate. Service has the logic; just needs the route |
| P4P5 | `POST /api/proposals/:id/render` + `GET /api/proposals/:id/download/:format` | Pandoc-optional rendering. Markdown always succeeds; PDF/docx return `RESOURCE_UNAVAILABLE` (502) when Pandoc isn't installed |
| P4P6 | `GET /api/proposals/templates` | Lists templates from both `modules/proposals/templates/` and `drafts/_templates/proposals/`. Override wins on name collision |
| P4P7 | `GET /api/projects/:id/scope-files` | New Proposal dialog `Build from scope` tab — lists every `scope.md` under `projects/<n>/in/<*>/` |
| P4P8 | `GET /api/proposals/:id/history` | Joins `audit_log` rows (`module='proposals' AND target_id IN (<estimate ids + proposal id>)`) with event log; returns chronological list. Depends on P2P5 (`audit_log.project_id`) |
| P4P9 | `module.reloaded` event when `modules/proposals/templates/*` or `drafts/_templates/proposals/*` mtime changes | Frontend can invalidate `proposals.templates()` cache without a restart |
| P4P10 | `POST /api/proposals/actions` discovery via Phase 1.5 P2S1 already covers SKILL.md scan — verify no extra wiring needed | Sanity check; Proposals skills already exist (`build-estimate`, `generate-proposal`) |

---

## 8. Phasing within Phase 4

1. **P0 — Backend route normalisation + new endpoints** (P4P1-P4P9).
2. **P1 — List route** (artifact stream, KPI strip, row design, filter pills).
3. **P2 — Detail shell** (split layout, toolbar, status badge).
4. **P3 — Estimate editor** (line-items table, inline edits, totals).
5. **P4 — Proposal preview** (markdown render, regenerate, download menu).
6. **P5 — Generation flow** (`+ New proposal` dialog, Build from scope, Start blank, spawned-session inline stream).
7. **P6 — Revise + supersede flows** (confirm dialog, predecessor chain).
8. **P7 — History popover + Project Proposals tab content**.
9. **P8 — Polish + agent QA**.

Estimate: **7-10 days** focused work. The v2-business-flow's "~1-2 weeks" matches at the upper end once Pandoc renderer + history view + agent integration are priced in.

---

## 9. What this spec does NOT pin

- **Real-time collaboration** on the estimate editor (out — single-user).
- **Visual diff** between revised estimate versions (future polish; `?compare=` reserved).
- **Template editor in the UI** — templates stay file-on-disk in v2.
- **`send_proposal`** outbound email — explicitly out per v2.
- **Custom pricing kinds** beyond `fixed / time_and_materials / unit` — the schema's `kind` is a rendering hint; skill authors layer richer pricing in templates.

---

## 10. Cross-references

- Phase 4 punch list: [`./phase-4-proposals-punchlist.md`](./phase-4-proposals-punchlist.md)
- Domain spec: [`./v2-business-flow.md#modulesproposals`](./v2-business-flow.md#modulesproposals)
- Phase 2 (Projects, prerequisite for the Proposals tab container): [`./phase-2-projects-impl-spec.md`](./phase-2-projects-impl-spec.md)
- Phase 3 (Email + scope-extractor produces the scope.md files this phase consumes): [`./phase-3-email-impl-spec.md`](./phase-3-email-impl-spec.md)
- Phase 1.5 conventions: [`./phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md)
- Server-side: [`../../modules/proposals/`](../../modules/proposals/)

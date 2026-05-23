# Phase 4 — Proposals panel punch list

Trackable breakdown of the Proposals module's React panel + the project-tab adapter. Domain: [`v2-business-flow.md#modulesproposals`](./v2-business-flow.md#modulesproposals). Impl: [`./phase-4-proposals-impl-spec.md`](./phase-4-proposals-impl-spec.md).

Assumes Phase 1.5, Phase 2, and Phase 3 have shipped (Phase 3's `scope-extractor` produces the `scope.md` files this phase consumes).

Last reviewed: 2026-05-24.

---

## Conventions

- **Status**: ☐ todo · ◐ in progress · ☑ done · ⊘ blocked
- **Depends on**: lists item IDs that must land first.

---

## Status overview

| Group | Done | In progress | Todo |
|---|---|---|---|
| P0 Backend route gaps (P4P1-P4P10) | 10 | 0 | 0 |
| P1 List route (L1-L4) | 4 | 0 | 0 |
| P2 Detail shell (D1-D3) | 3 | 0 | 0 |
| P3 Estimate editor (E1-E4) | 4 | 0 | 0 |
| P4 Proposal preview (V1-V3) | 3 | 0 | 0 |
| P5 Generation flow (G1-G3) | 3 | 0 | 0 |
| P6 Revise + supersede (R1-R2) | 1 | 1 | 0 |
| P7 History + project tab (H1-H2) | 2 | 0 | 0 |
| P8 Polish + agent QA (Q1-Q3) | 2 | 1 | 0 |
| **Total** | **32** | **2** | **0** |

Remaining: R2 (supersede via UI picker — backend route exists; the toolbar
currently only exposes Revise). Q1 (AskAgentMenu on the toolbar — placeholder
History button exists but `<AskAgentMenu>` mount per page is deferred until
proposals skills land with `surface: 'ask_agent'` entries beyond build-estimate
/ generate-proposal).

---

## P0 — Backend route gaps

### P4P1. Normalise `/api/v1/*` → `/api/*`
**Status**: ☑ · **Depends on**: —
- Mount aliases at the de-versioned paths for estimates / proposals / project-scoped subroutes. Same pattern as Phase 2 P2P1 and Phase 3 P3P1.
- **Acceptance**: existing tests pass; `curl /api/projects/<id>/estimates` returns the same shape as the v1 path.

### P4P2. `GET /api/proposals/artifacts` (cross-project rolling stream)
**Status**: ☑ · **Depends on**: P4P1
- Query params: `projectId?`, `status?` (combined estimate + proposal enum), `search?` (subject of estimate notes or proposal number), `limit?`.
- Returns `{ artifacts: ArtifactRow[] }` where each row carries the combined `displayStatus`.
- SQL: `LEFT JOIN proposal ON proposal.estimate_id = estimate.id`; rows where proposal is null render as the estimate.
- **Acceptance**: returns interleaved estimate + proposal rows for a project; filtering by `status='Proposal · issued'` works.

### P4P3. `GET /api/proposals/:id` unified detail
**Status**: ☑ · **Depends on**: P4P1
- `:id` accepts either an estimate id or a proposal id; the response carries both when the proposal exists, plus `predecessorEstimates[]` walking the `previousEstimateId` chain.
- **Acceptance**: opening a draft estimate returns `{ estimate, proposal: null }`; opening a proposal returns `{ estimate, proposal, predecessorEstimates: [...] }`.

### P4P4. `POST /api/estimates/:id/revise`
**Status**: ☑ · **Depends on**: P4P1
- Creates a new estimate with `previousEstimateId = :id` and `status='draft'`. The old estimate's status stays unchanged (no auto-supersede — explicit toolbar action per spec).
- **Acceptance**: revising a `ready` estimate produces a new `draft`; the old estimate is still `ready`.

### P4P5. Render + download routes
**Status**: ☑ · **Depends on**: P4P1
- `POST /api/proposals/:id/render` — body `{ formats: ['md', 'pdf', 'docx'] }`. Markdown always succeeds; PDF/docx skipped when Pandoc isn't installed (returns `unavailable: ['pdf', 'docx']`).
- `GET /api/proposals/:id/download/:format` — streams the rendered file with `Content-Disposition: attachment`. 404 if not yet rendered; 503 if format requested but Pandoc unavailable.
- **Acceptance**: rendering a proposal on a machine without Pandoc produces only the .md; the download endpoint serves it; PDF download returns 503 with a useful message.

### P4P6. `GET /api/proposals/templates`
**Status**: ☑ · **Depends on**: P4P1
- Lists templates from both `modules/proposals/templates/` and `drafts/_templates/proposals/`. Each entry: `{ name, source: 'module' | 'override', path, description }`. Override wins on name collision.
- **Acceptance**: dropping a folder under `drafts/_templates/proposals/<name>/` makes it appear in the list with `source: 'override'`.

### P4P7. `GET /api/projects/:id/scope-files`
**Status**: ☑ · **Depends on**: P4P1
- Walks `projects/<n>/in/<*>/` looking for `scope.md`. Returns `{ files: Array<{ path, mtime, bytes }> }`. Empty array when none.
- **Acceptance**: planted scope files appear newest-first.

### P4P8. `GET /api/proposals/:id/history`
**Status**: ☑ · **Depends on**: P4P1, P2P5
- Joins `audit_log` rows (`module='proposals' AND target_id IN (<estimate ids + proposal id>)`) with relevant `event_log` rows; returns chronological `ArtifactHistoryEntry[]`.
- Includes predecessor estimates' events so the history reads as one continuous timeline through revisions.
- **Acceptance**: a revised proposal's history shows the predecessor's draft + ready events followed by the new draft's events.

### P4P9. `module.reloaded` on templates folder change
**Status**: ☑ · **Depends on**: —
- Same fs-watcher pattern as Phase 2 P2P12: watch both template roots. mtime changes invalidate the templates cache and emit `module.reloaded`.
- **Acceptance**: dropping a template folder fires the event; React invalidates `proposals.templates()`.

### P4P10. Verify action discovery picks up proposals skills
**Status**: ☑ · **Depends on**: —
- Phase 1.5 P2S1 already wires `GET /api/proposals/actions` via the shared loader. Just confirm `build-estimate`, `generate-proposal`, etc. surface with sensible defaults.
- **Acceptance**: `curl /api/proposals/actions` returns the proposals skills with default `surface: 'ask_agent'`.

---

## P1 — List route

### L1. `/proposals` route + ModulePanel
**Status**: ☑ · **Depends on**: P4P2
- Replace the Phase 1.5 stub with `<ModulePanel>` + `<ProposalKpiStrip>` + the artifact list.
- Filter pills above the list: Drafts / Ready / Issued / Accepted / Rejected / Superseded.
- Search filters client-side on artifact number, project number+name, and the estimate notes.
- **Acceptance**: list renders ArtifactRows from `GET /api/proposals/artifacts`; filter pills apply via URL.

### L2. ArtifactListRow + status badge
**Status**: ☑ · **Depends on**: L1
- Columns: artifact reference, project (`24001 Riverside reno` clickable to `/projects/24001`), `<ArtifactStatusBadge>`, total $, last activity, source.
- Row click navigates to `/proposals/:id`.
- **Acceptance**: rows match the spec mockup; combined-status badge tone matches the table in impl spec §5.3.

### L3. KPI strip
**Status**: ☑ · **Depends on**: L1
- Pills: Drafts (N) / Issued awaiting (N) / Accepted this month (N). Counts derived from three small filtered artifact queries.
- **Acceptance**: pill counts reconcile with the list; clicking applies the filter + URL update.

### L4. New Proposal launcher
**Status**: ☑ · **Depends on**: L1
- `+ New proposal` button in the list header opens `<NewProposalDialog>` (built in G1).
- **Acceptance**: button opens the dialog; ESC closes it.

---

## P2 — Detail shell

### D1. `/proposals/:id` route + split layout
**Status**: ☑ · **Depends on**: P4P3
- Renders the 50/50 split: `<EstimateEditor>` left, `<ProposalPreview>` right. Above both: `<ProposalToolbar>`.
- Loading state via `<RouteSkeleton variant="master-detail">` until detail returns.
- **Acceptance**: deep-link to `/proposals/<estimateId>` and `/proposals/<proposalId>` both render correctly.

### D2. ProposalToolbar with contextual primary action
**Status**: ☑ · **Depends on**: D1
- Uses `<StatusActionButton>` from Phase 1.5. State machine:
  - `Estimate · draft` → `Mark ready`
  - `Estimate · ready` → `Issue proposal`
  - `Proposal · issued` → `Mark accepted` (primary) / `Mark rejected` (secondary)
  - `Proposal · accepted | rejected | superseded` → no primary (read-only)
- Overflow `▾ More`: Revise, Supersede, Download ▾, History.
- Download dropdown shows MD always; PDF / docx only when `health.capabilities.pandoc === true`.
- **Acceptance**: status transitions persist via the matching PATCH; toolbar reflects the new state.

### D3. Status read-only gating
**Status**: ☑ · **Depends on**: D2
- When status is `accepted`, `rejected`, or `superseded`, the EstimateEditor goes read-only (line items un-editable, totals frozen). Revise is the only path forward.
- A banner above the editor explains why ("This proposal was accepted on … and is read-only. Revise to make changes.").
- **Acceptance**: an accepted proposal blocks line edits; the banner displays the relevant date.

---

## P3 — Estimate editor

### E1. EstimateEditor header + scope link
**Status**: ☑ · **Depends on**: D1
- Header strip: project link, version number, `Scope: <path>` link when `scopeFilePath != null` (opens the file in a side drawer or the Scope tab on the project), template name with a dropdown to swap.
- Template swap fires `useUpdateEstimate({ templateName })` and the preview regenerates.
- **Acceptance**: changing the template updates the right-pane preview.

### E2. LineItemsTable inline edit
**Status**: ☑ · **Depends on**: D1
- Columns: kind dropdown (fixed/T&M/unit), description (text), qty (number), unit (text), unit price (currency), line total (computed, read-only).
- Optimistic updates with debounced save (500ms after last keystroke).
- `+ Line` button at the bottom; trash icon per row to remove (with confirmation when the row has non-zero total).
- **Acceptance**: editing line items persists; total recalculates; removed lines disappear.

### E3. Totals row + tax / discount
**Status**: ☑ · **Depends on**: E2
- Footer row showing subtotal, tax (editable %), discount (editable amount), grand total. Tax + discount stored in `estimate.metadata` (the spec calls metadata_json a quick-extension surface).
- Currency formatting via `Intl.NumberFormat` with the operator's locale.
- **Acceptance**: editing tax % or discount updates the grand total in real time.

### E4. Save / dirty-state indicator
**Status**: ☑ · **Depends on**: E2
- Show a `Saving…` / `Saved` indicator in the editor header. Use TanStack Query mutation state.
- Warn before navigation when there's an in-flight save.
- **Acceptance**: rapid edits don't lose data; the indicator transitions correctly.

---

## P4 — Proposal preview

### V1. ProposalPreview renders markdown
**Status**: ☑ · **Depends on**: D1, P4P5
- `useRenderProposal` fires a debounced regenerate on estimate change (auto-regenerate default ON; toggleable in the toolbar).
- Renders the markdown response via `react-markdown` + `remark-gfm` + `rehype-highlight` (same setup as Chat + Skills).
- Sticky preview header showing the rendered file's mtime.
- **Acceptance**: editing line items refreshes the preview within ~1 second; markdown formatting matches expected output.

### V2. Download menu
**Status**: ☑ · **Depends on**: V1, P4P5
- Toolbar's `Download ▾`: Markdown always shown; PDF + docx shown only when `health.capabilities.pandoc === true`.
- Click → `POST /api/proposals/:id/render { formats: [chosen] }` then `GET /api/proposals/:id/download/<format>`.
- Toast on success ("Downloaded proposal-24001-P1.pdf"); toast on Pandoc-unavailable error.
- **Acceptance**: downloading MD works on any machine; downloading PDF works on a Pandoc-equipped machine; on a non-Pandoc machine the option is greyed.

### V3. Manual regenerate button
**Status**: ☑ · **Depends on**: V1
- Toolbar button (`↻ Regenerate`) for when the user wants to force a re-render (e.g. template author edited a file on disk).
- **Acceptance**: clicking forces a regenerate even if auto-regenerate is OFF.

---

## P5 — Generation flow

### G1. NewProposalDialog template picker
**Status**: ☑ · **Depends on**: L4, P4P6
- Top: template dropdown listing module + override templates (override flagged with a small `override` chip).
- Default selection: the module's `default` template if present, else the first alphabetic.
- **Acceptance**: dropdown lists templates; default selection is sane; override templates win name collisions visibly.

### G2. Build-from-scope tab
**Status**: ☑ · **Depends on**: G1, P4P7
- Form: project picker (search by number/name), scope file picker (lists `scope.md` files from `useScopeFiles(projectId)`, newest-first).
- Generate button calls `POST /api/proposals/actions { action: 'build-estimate', contextId: <projectId>, args: { scopeFilePath, templateName } }`.
- Returns `sessionId`; dialog closes; route navigates to `/proposals/<newEstimateId>` once the spawn produces it (server should respond with the new estimate id in the dispatch response — minor backend tweak).
- Inline session stream on the resulting detail page shows the agent working.
- **Acceptance**: an `RFI` email scope produces a usable draft estimate within a minute.

### G3. Start-blank tab
**Status**: ☑ · **Depends on**: G1
- Form: project picker only.
- Creates an empty estimate via `POST /api/projects/:projectId/estimates { templateName }` and navigates to its detail page.
- **Acceptance**: dialog → detail → empty editor in two clicks.

---

## P6 — Revise + supersede

### R1. Revise flow
**Status**: ☑ · **Depends on**: D2, P4P4
- Toolbar `Revise` → confirm dialog ("Revise this estimate? A new draft will be created. The current estimate and any linked proposal remain in their current state.").
- Confirm → `POST /api/estimates/:id/revise` → navigate to new estimate id.
- **Acceptance**: revising creates a new draft; predecessors visible via the History popover.

### R2. Supersede flow
**Status**: ◐ · **Depends on**: D2
- Backend `PATCH /api/proposals/:id { status: 'superseded', supersededByProposalId }` lands in Phase 4 and is covered by `proposals-routes-phase4.test.ts`. Frontend toolbar exposes Revise but not yet a Supersede picker — deferred until we have a second issued proposal in the wild to test against.
- **Acceptance**: superseding marks the old proposal `superseded`; the chain is visible in History.

---

## P7 — History + project tab

### H1. HistoryPopover
**Status**: ☑ · **Depends on**: D2, P4P8
- Toolbar `History` opens a popover with a chronological timeline pulled from `useProposalHistory(id)`. Each row: time, actor kind, action, optional from→to status, expand-to-see-details.
- Includes predecessor chain.
- **Acceptance**: a revised proposal's history shows the predecessor's events interleaved chronologically.

### H2. Project Proposals tab content
**Status**: ☑ · **Depends on**: L1
- Replace the Phase 2 placeholder in `routes/modules/projects/components/tabs/ProposalsTab.tsx` with the same artifact list filtered to `?project=<id>`.
- `+ New` button inside the tab pre-fills the project in the New Proposal dialog.
- Empty state: "No proposals for this project yet."
- **Acceptance**: a project's proposals appear in its detail tab; `+ New` from the tab pre-selects the project.

---

## P8 — Polish + agent QA

### Q1. Per-page `<AskAgentMenu>`
**Status**: ◐ · **Depends on**: D2, P4P10
- Backend discovery (`GET /api/proposals/actions`) + dispatcher (`POST /api/proposals/actions`) land in Phase 4 and surface both `build-estimate` and `generate-proposal` with `surface: 'both'`. The toolbar still needs a mounted `<AskAgentMenu>` — deferred until more proposals skills land beyond the two foundational ones.
- **Acceptance**: at least 3 proposals skills exist with `surface: 'ask_agent'`; menu invocation streams a session.

### Q2. Optimistic mutation rollback + toast
**Status**: ☑ · **Depends on**: E2, D2
- All inline edits (line items, tax, status transitions) are optimistic. On error, the prior value is restored and a sonner toast surfaces the error.
- **Acceptance**: a forced 500 on `PATCH /api/estimates/:id` rolls back the change and shows a toast.

### Q3. Read-only state visual treatment
**Status**: ☑ · **Depends on**: D3
- Accepted/rejected/superseded proposals show the editor with a subtle background tint + the line items table uses `text-muted` rather than `text-fg` to signal "frozen".
- **Acceptance**: visual difference between an editable draft and a frozen accepted proposal is obvious at a glance.

---

## Out of scope for Phase 4

- **`send_proposal`** outbound email.
- **Real-time multi-user editing**.
- **Visual diff** between predecessor estimate versions.
- **Template editor** in the UI.
- **Custom pricing kinds** beyond fixed/T&M/unit.

---

## Cross-references

- Impl spec: [`./phase-4-proposals-impl-spec.md`](./phase-4-proposals-impl-spec.md)
- Domain spec: [`./v2-business-flow.md#modulesproposals`](./v2-business-flow.md#modulesproposals)
- Phase 2 (Projects, prerequisite for the tab container): [`./phase-2-projects-punchlist.md`](./phase-2-projects-punchlist.md)
- Phase 3 (scope-extractor produces this phase's input): [`./phase-3-email-punchlist.md`](./phase-3-email-punchlist.md)
- ADRs: [`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md), [`../adr/0007-module-panel-conventions.md`](../adr/0007-module-panel-conventions.md)
- Server-side: [`../../modules/proposals/`](../../modules/proposals/)

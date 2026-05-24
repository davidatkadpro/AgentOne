# Phase 5 — Invoicing + QBO punch list

Trackable breakdown of the Invoicing module's React panel, the QBO sync engine, the OAuth flow, and the Project Invoices tab. Domain spec + QBO contract: [`v2-business-flow.md#modulesinvoicing`](./v2-business-flow.md#modulesinvoicing). Impl scaffolding: [`./phase-5-invoicing-impl-spec.md`](./phase-5-invoicing-impl-spec.md).

Assumes Phases 1.5, 2, 3, 4 have shipped (Phase 4's `from-proposal` flow seeds invoices; Phase 2's budget plumbing returns real values once Phase 5 wires the view).

Last reviewed: 2026-05-24.

---

## Conventions

- **Status**: ☐ todo · ◐ in progress · ☑ done · ⊘ blocked
- **Depends on**: lists item IDs that must land first.

---

## Status overview

| Group | Done | In progress | Todo |
|---|---|---|---|
| P0 Backend route gaps (P5P1-P5P15) | 15 | 0 | 0 |
| P1 Local invoice list + detail (L1-L6) | 6 | 0 | 0 |
| P2 Vault + connection schema (T1-T2) | 2 | 0 | 0 |
| P3 OAuth + Integrations panel (O1-O4) | 4 | 0 | 0 |
| P4 QBO push (P1-P2) | 2 | 0 | 0 |
| P5 QBO pull + poller (U1-U3) | 3 | 0 | 0 |
| P6 Drift reconcile UI (D1-D4) | 4 | 0 | 0 |
| P7 reconcile-drift skill (S1) | 1 | 0 | 0 |
| P8 Project Invoices tab + budget (X1-X2) | 2 | 0 | 0 |
| P9 Polish + agent QA (Q1-Q3) | 3 | 0 | 0 |
| **Total** | **42** | **0** | **0** |

---

## P0 — Backend route gaps + plumbing

### P5P1. Normalise `/api/v1/{invoices,projects/:pid/invoices,…}/*` → `/api/invoicing/*`
**Status**: ☑ · **Depends on**: —
- Aliases at the new path; deprecation log on the v1 path. Same pattern as Phases 2-4.
- **Acceptance**: existing tests pass; `curl /api/invoicing/invoices` returns expected shape.

### P5P2. `GET /api/invoicing/invoices` (cross-project list)
**Status**: ☑ · **Depends on**: P5P1
- Query: `projectId?`, `status?`, `syncStatus?`, `limit?`.
- **Acceptance**: returns interleaved invoices across projects; filter combos work.

### P5P3. `src/storage/secret-vault.ts` encryption helper
**Status**: ☑ · **Depends on**: —
- Two backends: DPAPI on Windows (`CryptProtectData` via Win32 binding); AES-GCM with `QBO_TOKEN_KEY` env var elsewhere.
- API: `encrypt(plaintext: string): Buffer` / `decrypt(buf: Buffer): string`.
- Fails fast at boot if running on non-Windows without `QBO_TOKEN_KEY`.
- **Acceptance**: round-trip encryption works on both platforms; tokens decrypt across restarts.

### P5P4. `qbo_connection` table migration
**Status**: ☑ · **Depends on**: P5P3
- SQL per v2-business-flow §Token storage. `CHECK (id = 1)` enforces single-row.
- **Acceptance**: migration applies cleanly; trying to insert a second row fails.

### P5P5. `POST /api/invoicing/invoices/:id/push`
**Status**: ☑ · **Depends on**: P5P4
- Full contract per v2-business-flow §QBO endpoint contract. Idempotent over local invoice id. `force: true` overwrites QBO on drift.
- Errors: 409 NOT_CONNECTED | DRIFT | INVOICE_NOT_ISSUED; 502 QBO_ERROR.
- Emits `qbo.invoice_pushed` on success; `qbo.sync_failed` on 502.
- **Acceptance**: pushing a fresh Issued invoice writes it to QBO sandbox; re-pushing updates the same QBO doc.

### P5P6. `POST /api/invoicing/invoices/:id/pull`
**Status**: ☑ · **Depends on**: P5P4
- Per the contract. Sets `sync_status='drift'` + records `driftFields[]` when divergent; emits `qbo.drift_detected` (drift) or `qbo.invoice_pulled` (clean).
- **Acceptance**: pulling a QBO-modified invoice flags drift with the right field paths.

### P5P7. `POST /api/invoicing/invoices/:id/reconcile`
**Status**: ☑ · **Depends on**: P5P5, P5P6
- Three strategies: `keep_local` (push overwrite), `accept_qbo` (pull overwrite local), `merge` (apply `merged` then push).
- Errors: 409 NOT_IN_DRIFT | NOT_CONNECTED; 422 INVALID_MERGE; 502 QBO_ERROR.
- **Acceptance**: all three strategies clear drift; merged values land in both local + QBO.

### P5P8. `GET /api/invoicing/qbo/status`
**Status**: ☑ · **Depends on**: P5P4
- Always returns 200. Disconnected: `{ connected: false }`. Connected: full envelope per spec.
- Token expiry computed; never returns the actual access token.
- **Acceptance**: route returns the right shape in both states.

### P5P9. `GET /api/integrations/qbo/connect` (302 to QBO)
**Status**: ☑ · **Depends on**: P5P4
- Generates one-time state token (5-min TTL, in-memory). Redirects to `https://appcenter.intuit.com/connect/oauth2?...&state=<token>&scope=com.intuit.quickbooks.accounting`.
- **Acceptance**: click the Connect button → browser lands on QBO auth page.

### P5P10. `GET /api/integrations/qbo/callback`
**Status**: ☑ · **Depends on**: P5P9
- Exchanges `code` for tokens, encrypts via secret-vault, upserts `qbo_connection`. Redirects to `/settings?tab=integrations&qbo=connected` (success) or `&qbo=error&reason=<code>` (failure).
- State token validation; rejects mismatch.
- **Acceptance**: full OAuth round-trip lands the operator back in Settings with a connected status.

### P5P11. `POST /api/integrations/qbo/disconnect`
**Status**: ☑ · **Depends on**: P5P10
- Best-effort QBO revoke; always clears local row. Emits `qbo.disconnected`.
- **Acceptance**: disconnecting clears the local row even if the QBO revoke endpoint fails.

### P5P12. Scheduled QBO pull poller
**Status**: ☑ · **Depends on**: P5P6
- Uses Phase 1's scheduler primitive. Interval configurable via env (`QBO_PULL_INTERVAL_MIN`, default 15).
- For each invoice with `qbo_id`, compare against QBO; flag drift or refresh `last_synced_at`.
- Pauses gracefully when disconnected.
- **Acceptance**: poller runs every interval; updated QBO invoice flagged within the interval window.

### P5P13. `GET /api/invoicing/invoices/:id/download/:format`
**Status**: ☑ · **Depends on**: P5P1
- Markdown always; PDF via Pandoc when available (mirrors proposals download).
- **Acceptance**: download endpoint serves the right Content-Type.

### P5P14. Audit + events wiring
**Status**: ☑ · **Depends on**: P2P5
- Every sync mutation writes an `audit_log` row: `module='invoicing'`, action in `{ invoice.push, invoice.pull, invoice.reconcile, qbo.connect, qbo.disconnect }`, `target_id=invoice.id` (or null for connect/disconnect), `project_id` resolved from invoice → proposal → project chain.
- **Acceptance**: every QBO action surfaces in the Activity tab of the relevant project.

### P5P15. Real `project_budget` view + `GET /api/projects/:id/budget` values
**Status**: ☑ · **Depends on**: P5P2
- Phase 2 P2P9 returned zeros. Phase 5 wires the real SQL view from v2-business-flow §Budget.
- **Acceptance**: a project with one $10k accepted proposal + a $4k invoice with $3k paid shows budget=10000, invoiced=4000, paid=3000.

---

## P1 — Local invoice list + detail (shippable without QBO)

### L1. `/invoicing` route + ConnectionBanner
**Status**: ☑ · **Depends on**: P5P1, P5P2, P5P8
- Replace the Phase 1.5 stub. List driven by `useInvoices()`. `<ConnectionBanner>` renders when QBO is disconnected or expired.
- Status filter pills above the list (Draft, Issued, Partially paid, Paid, Void).
- **Acceptance**: list renders rows; banner appears when QBO disconnected.

### L2. InvoiceListRow + dual status badges
**Status**: ☑ · **Depends on**: L1
- Columns: invoice number, project (clickable), `<InvoiceStatusBadge>`, `<SyncStatusBadge>`, total, balance, last activity.
- **Acceptance**: visual parity with the spec; badges use the colour map.

### L3. InvoiceKpiStrip
**Status**: ☑ · **Depends on**: L1
- Pills: Outstanding $, Overdue $, Drift (N), Sync-failed (N). Each clickable, applies a filter.
- "Overdue" = `status in (issued, partially_paid) AND due_date < now`.
- **Acceptance**: pills compute correctly; filtering works.

### L4. `/invoicing/:id` route + InvoiceHeader
**Status**: ☑ · **Depends on**: P5P1
- Header strip with totals + `<StatusActionButton>` driving the local state machine (Draft → Issue → Mark partially/Paid → Void).
- Overflow `▾ More`: Download MD/PDF (Pandoc-gated), History, Supersede, Void.
- **Acceptance**: status transitions persist; overflow menu shows / hides based on capabilities.

### L5. LineItemsTable + PaymentsSection
**Status**: ☑ · **Depends on**: L4
- Line items: same shape as the proposals editor; read-only when status ∈ {paid, void}.
- Payments: list of rows + `+ Record payment` opening `<RecordPaymentDialog>`.
- **Acceptance**: editing line items persists; recording a payment moves the invoice toward partially_paid / paid.

### L6. NewInvoiceDialog (From proposal / Blank)
**Status**: ☑ · **Depends on**: L1
- From proposal: project picker → accepted-proposal picker → server auto-suggests `<project-number>-<seq>` → draft pre-populated from the proposal's estimate lines.
- Blank: project picker → empty draft.
- **Acceptance**: both tabs land the user on `/invoicing/<newId>`.

---

## P2 — Vault + connection schema

### T1. Implement `src/storage/secret-vault.ts`
**Status**: ☑ · **Depends on**: —
- See P5P3.
- **Acceptance**: round-trip encryption works on both DPAPI and AES-GCM paths.

### T2. Apply `qbo_connection` migration
**Status**: ☑ · **Depends on**: T1
- See P5P4.
- **Acceptance**: table exists with constraints; single-row enforced.

---

## P3 — OAuth + Integrations panel

### O1. Backend OAuth routes
**Status**: ☑ · **Depends on**: T2
- P5P9 + P5P10 + P5P11 wired.
- **Acceptance**: full Connect → consent → Callback → Disconnect round-trip works against the QBO sandbox.

### O2. QboIntegrationPanel — Not connected state
**Status**: ☑ · **Depends on**: O1
- Replace Phase 1.5 `IntegrationsTab.tsx` stub with the real panel.
- Explainer + `<a href="/api/integrations/qbo/connect">Connect</a>` link (no fetch — must be a real navigation).
- **Acceptance**: clicking Connect navigates to the QBO consent screen.

### O3. QboIntegrationPanel — Connected state
**Status**: ☑ · **Depends on**: O2
- Shows companyName, realmId (last 4), connected since, token expiry, lastPushAt, lastPullAt, lastError (collapsible).
- `Disconnect` button (red) → AlertDialog confirm → `POST /api/integrations/qbo/disconnect`.
- On mount, reads `?qbo=connected|error` and shows a sonner toast.
- **Acceptance**: panel reflects the right state; Disconnect clears the row.

### O4. ConnectionBanner on `/invoicing`
**Status**: ☑ · **Depends on**: O1, L1
- Renders at the top of the list when `!qbo.connected` OR `qbo.tokenExpiresAt < now`.
- Body: "QuickBooks is disconnected. Push & pull are paused. <Reconnect> in Settings." Reconnect link deep-links to `/settings?tab=integrations`.
- **Acceptance**: banner appears in the right states; hidden when connected.

---

## P4 — QBO push

### P4-1. Backend push route
**Status**: ☑ · **Depends on**: O1
- P5P5 wired. Maps local invoice → QBO Invoice via `src/modules/qbo/push.ts`.
- **Acceptance**: pushing a fresh Issued invoice writes it to the QBO sandbox; `qbo_id` populated locally.

### P4-2. SyncSection + Push button
**Status**: ☑ · **Depends on**: P4-1, L4
- New section on the detail page: synced timestamp, qboId, qboDocNumber, lastError, `Push to QBO` button (disabled when !connected || status === 'draft').
- Optimistic chip update; success toast; failure toast with the QBO error message.
- **Acceptance**: clicking Push completes within ~3 seconds; UI updates.

---

## P5 — QBO pull + poller

### U1. Backend pull route
**Status**: ☑ · **Depends on**: P4-1
- P5P6 wired. Computes diff fields per the spec.
- **Acceptance**: pulling a QBO-modified invoice flags drift with the correct field paths.

### U2. Pull button on SyncSection
**Status**: ☑ · **Depends on**: U1, P4-2
- Adjacent to Push: `Pull from QBO` button (disabled when !connected || !qboId).
- **Acceptance**: clicking Pull fetches latest QBO state; drift status badges update.

### U3. Scheduled pull poller
**Status**: ☑ · **Depends on**: U1
- P5P12 wired. Configurable interval; pauses when disconnected.
- **Acceptance**: external QBO changes appear locally within the interval.

---

## P6 — Drift reconcile UI

### D1. Drift detection persists `driftFields` + `local` / `qbo` snapshots
**Status**: ☑ · **Depends on**: U1
- Server stores enough state on drift detection that the UI can render side-by-side diffs without re-fetching QBO. Snapshots live in the invoice's `qbo_pull_snapshot_json` column (new — small schema add).
- **Acceptance**: detail endpoint returns `{ invoice, drift: { driftFields, local, qbo } }` when drift; null otherwise.

### D2. DriftBlock side-by-side renderer
**Status**: ☑ · **Depends on**: D1
- Renders divergent fields as a side-by-side table; highlights differences. Primary buttons: `Keep local (push)`, `Accept QBO (pull)`, `Custom merge`.
- **Acceptance**: a drift case renders the right fields with the right values on each side.

### D3. MergePicker for Custom merge
**Status**: ☑ · **Depends on**: D2
- Per-field radio (Local / QBO). Selecting an option for every field enables the Commit button.
- Commit calls `POST /api/invoicing/invoices/:id/reconcile { strategy: 'merge', merged }`.
- **Acceptance**: walking through a 3-field drift produces a merged QBO doc.

### D4. Reconcile mutation wiring + toasts
**Status**: ☑ · **Depends on**: P5P7, D2
- All three strategies invalidate the right cache keys; toasts on success / failure.
- **Acceptance**: each strategy clears drift and refreshes the UI.

---

## P7 — `reconcile-drift` skill (agent-as-escape)

### S1. Skill end-to-end
**Status**: ☑ · **Depends on**: D2
- Skill action under `modules/invoicing/skills/reconcile-drift/` already declared. Phase 5 wires its prompt template + tools (`getInvoiceDrift`, `applyReconcile`).
- Triggered via a `Use agent ▸` link inside `<DriftBlock>` — spawns a session that streams inline below the block, requests `request_user_input` for the strategy choice, then calls `POST /api/invoicing/invoices/:id/reconcile`.
- **Acceptance**: invoking the skill on a drift case walks the operator through the agent's reasoning and resolves drift.

---

## P8 — Project Invoices tab + budget rollup

### X1. Replace Phase 2 InvoicesTab placeholder
**Status**: ☑ · **Depends on**: L1, P5P15
- `routes/modules/projects/components/tabs/InvoicesTab.tsx` renders the same invoice list filtered to `?projectId=`.
- Adds a `<BudgetKpiStrip>` at the top: Budget / Invoiced / Paid / Outstanding.
- **Acceptance**: a project's invoices appear in its detail tab; budget rollup matches the `project_budget` view.

### X2. BudgetKpiStrip in the project header chip
**Status**: ☑ · **Depends on**: X1, P5P15
- Update Phase 2's ProjectHeaderStrip budget chip to show real values from the now-live view.
- **Acceptance**: project header reflects real invoiced/paid totals.

---

## P9 — Polish + agent QA

### Q1. Status badge consistency
**Status**: ☑ · **Depends on**: L2
- Both `<InvoiceStatusBadge>` and `<SyncStatusBadge>` used consistently across list, detail, project tab.
- **Acceptance**: a draft invoice renders identically in all three places.

### Q2. Error UX
**Status**: ☑ · **Depends on**: P4-2, U2, D4
- All QBO mutations surface failures via sonner toast with a useful error code + message.
- `502 QBO_ERROR` shows the upstream `qboMessage` field.
- **Acceptance**: forcing a QBO sandbox error surfaces a readable toast.

### Q3. `<AskAgentMenu>` on invoice detail
**Status**: ☑ · **Depends on**: L4
- Toolbar mounts `<AskAgentMenu module="invoicing" tab="">` with skills like `Reconcile this drift`, `Draft payment reminder`, `Explain the QBO push failure`.
- **Acceptance**: at least 3 invoicing skills exist with `surface: 'ask_agent'`; menu spawns sessions.

---

## Out of scope for Phase 5

- **Multi-company QBO** — schema deferred.
- **Auto-push-on-issue** — manual push only.
- **Webhook ingestion**.
- **Time-tracking integration**.
- **Milestone-based billing tab** in the New Invoice dialog (future skill).
- **Multi-currency invoices**.
- **Recurring invoices**.

---

## Cross-references

- Impl spec: [`./phase-5-invoicing-impl-spec.md`](./phase-5-invoicing-impl-spec.md)
- Domain spec + QBO contract: [`./v2-business-flow.md#modulesinvoicing`](./v2-business-flow.md#modulesinvoicing), [`./v2-business-flow.md#qbo-endpoint-contract`](./v2-business-flow.md#qbo-endpoint-contract)
- Phase 2 (Projects, budget plumbing prerequisite): [`./phase-2-projects-punchlist.md`](./phase-2-projects-punchlist.md)
- Phase 4 (Proposals, from-proposal seed): [`./phase-4-proposals-punchlist.md`](./phase-4-proposals-punchlist.md)
- Phase 1.5 conventions: [`./phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md)
- ADRs: [`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md), [`../adr/0007-module-panel-conventions.md`](../adr/0007-module-panel-conventions.md)
- Server-side: [`../../modules/invoicing/`](../../modules/invoicing/) + new `src/modules/qbo/` for the sync engine

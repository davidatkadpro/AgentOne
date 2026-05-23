# Phase 5 — Invoicing + QBO implementation spec

Implementation-level scaffolding for the Invoicing module's React panel, the QBO sync engine, the Settings → Integrations QuickBooks Online OAuth flow, and the Project detail's Invoices tab. Domain spec: [`v2-business-flow.md#modulesinvoicing`](./v2-business-flow.md#modulesinvoicing). QBO endpoint contract: [`v2-business-flow.md#qbo-endpoint-contract`](./v2-business-flow.md#qbo-endpoint-contract).

Mirrors [`phase-4-proposals-impl-spec.md`](./phase-4-proposals-impl-spec.md). Read [`phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md) for the foundational conventions.

Last reviewed: 2026-05-24. Treat as living.

---

## 0. Scope reminder

Phase 5 ships:
- **Invoicing panel** (`/invoicing`) — single-pane invoice list with status + sync badges and a connection-status banner.
- **Invoice detail** (`/invoicing/:id`) — single-pane sectioned layout: header, line items, payments, sync section, drift block (when applicable).
- **QBO OAuth flow** — Settings → Integrations → QuickBooks Online panel handles connect / disconnect / status.
- **QBO sync engine** — push, pull (scheduled poller), drift detection, reconcile.
- **Token storage** — `qbo_connection` single-row table with encrypted tokens via the new `src/storage/secret-vault.ts` helper (DPAPI on Windows; AES-GCM with `QBO_TOKEN_KEY` env var elsewhere).
- **Drift reconciliation UI** — side-by-side diff with `Keep local / Accept QBO / Custom merge` primary actions plus an `Use agent ▸` escape.
- **Project Invoices tab** content — replaces the Phase 2 placeholder; includes the budget rollup KPI strip.

Phase 5 does **not** ship: multi-company QBO support (explicit deferral — single `realm_id`), auto-push-on-issue (manual push only), webhook ingestion (poll-only), time-tracking integration (future module), milestone billing tab (future skill that drops into the existing dispatch dialog).

---

## 1. Folder layout

```
src/web/src/routes/modules/invoicing/
├── InvoicingRoute.tsx                # /invoicing — invoice list + connection banner
├── InvoiceDetailRoute.tsx            # /invoicing/:id — sectioned detail
├── components/
│   ├── InvoiceListRow.tsx            # number, project, local status, QBO status, total, balance, activity
│   ├── InvoiceStatusBadge.tsx        # Draft / Issued / Partially paid / Paid / Void
│   ├── SyncStatusBadge.tsx           # synced / pending / drift / failed
│   ├── ConnectionBanner.tsx          # top-of-list banner when QBO disconnected/expired
│   ├── InvoiceKpiStrip.tsx           # Outstanding $ · Overdue $ · Drift (N) · Sync-failed (N)
│   ├── NewInvoiceDialog.tsx          # From proposal / Blank tabs
│   ├── InvoiceHeader.tsx             # header strip with contextual primary + overflow
│   ├── LineItemsTable.tsx            # same shape as proposals editor
│   ├── PaymentsSection.tsx           # list + record-payment dialog
│   ├── RecordPaymentDialog.tsx
│   ├── SyncSection.tsx               # synced timestamp + Push / Pull buttons; expands into drift block
│   ├── DriftBlock.tsx                # side-by-side diff + Keep local / Accept QBO / Custom merge
│   ├── MergePicker.tsx               # field-level selector for Custom merge
│   └── InvoicingActionToolbar.tsx    # wraps <ActionToolbar> + inline session stream
└── hooks/
    ├── useQboStatus.ts               # GET /api/invoicing/qbo/status
    └── useInvoiceSync.ts             # push/pull/reconcile mutations
```

Settings tab:

```
src/web/src/routes/settings/
├── IntegrationsTab.tsx               # Phase 1.5 stub replaced — real QuickBooks panel
└── QboIntegrationPanel.tsx           # NEW — Connect / Disconnect / status / OAuth callback toast
```

Project-tab adapter:

```
src/web/src/routes/modules/projects/components/tabs/
├── InvoicesTab.tsx                   # replaces Phase 2 placeholder; filtered invoice list + budget KPI
└── BudgetKpiStrip.tsx                # Budget · Invoiced · Paid · Outstanding for the project
```

API hooks:

```
src/web/src/api/
├── invoicing.ts                      # NEW — useInvoices, useInvoice, useCreateInvoice, …
├── invoicing-sync.ts                 # NEW — usePushInvoice, usePullInvoice, useReconcile
└── qbo.ts                            # NEW — useQboStatus, useDisconnectQbo
```

Server-side new file:

```
src/storage/secret-vault.ts           # DPAPI / AES-GCM encryption helper
src/modules/qbo/                      # NEW backend folder
├── source.ts                         # QBO HTTP client (axios or fetch wrapper)
├── auth.ts                           # OAuth2 PKCE flow
├── poller.ts                         # scheduled pull poller (every 15 min)
├── push.ts                           # invoice → QBO mapping
├── pull.ts                           # QBO → invoice mapping + drift detection
└── routes.ts                         # mounts the 7 QBO endpoints
```

---

## 2. TypeScript types

Add to `src/web/src/types/domain.ts`:

```ts
export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void'
export type SyncStatus = 'synced' | 'pending' | 'drift' | 'failed' | 'not_pushed'

export interface InvoiceLine {
  id: string
  kind: 'fixed' | 'time_and_materials' | 'unit'
  description: string
  qty: number
  unit: string | null
  unitPriceCents: number
  lineTotalCents: number
  position: number
}

export interface Payment {
  id: string
  invoiceId: string
  amountCents: number
  paidAt: number                       // ms epoch
  method: 'check' | 'ach' | 'card' | 'cash' | 'other'
  reference: string | null
  notes: string | null
  createdAt: number
}

export interface Invoice {
  id: string
  number: string                       // e.g. "24001-01"
  projectId: string
  proposalId: string | null            // when generated from-proposal
  status: InvoiceStatus
  issueDate: number | null
  dueDate: number | null
  subtotalCents: number
  taxCents: number
  totalCents: number
  amountPaidCents: number
  balanceCents: number                 // server-computed: total - amountPaid
  lines: InvoiceLine[]
  payments: Payment[]
  notes: string | null

  // QBO sync fields
  qboId: string | null
  qboDocNumber: string | null          // QBO's own number; informational
  syncStatus: SyncStatus
  lastSyncedAt: number | null
  driftFields: string[]                // populated when syncStatus='drift'

  createdAt: number
  updatedAt: number
}

export interface QboConnection {
  connected: boolean
  realmId?: string
  companyName?: string
  connectedAt?: number
  tokenExpiresAt?: number
  lastPushAt?: number
  lastPullAt?: number
  lastError?: { code: string; message: string; at: number } | null
}

export interface ProjectBudget {
  projectId: string
  budgetTotalCents: number             // from accepted proposal's estimate
  invoicedTotalCents: number
  paidTotalCents: number
}

/** Side-by-side diff payload returned by the pull response when drift is
 *  detected. The UI renders the matched-field pairs in <DriftBlock>. */
export interface InvoiceDrift {
  invoiceId: string
  driftFields: string[]                // e.g. ["customerEmail", "lineItems[2].amount"]
  local: Record<string, unknown>       // current invoice state
  qbo: Record<string, unknown>         // pulled QBO state
}
```

### REST request/response types

```ts
// GET /api/invoicing/invoices  — cross-project list
export interface ListInvoicesQuery {
  projectId?: string
  status?: InvoiceStatus | InvoiceStatus[]
  syncStatus?: SyncStatus | SyncStatus[]
  limit?: number
}
export interface ListInvoicesResponse { invoices: Invoice[] }

// GET /api/invoicing/invoices/:id
export interface InvoiceDetailResponse {
  invoice: Invoice
  drift: InvoiceDrift | null           // populated only when syncStatus='drift'
}

// POST /api/projects/:projectId/invoices
export interface CreateInvoiceRequest {
  proposalId?: string | null
  number?: string                      // server suggests when omitted
  lines?: InvoiceLine[]
}
export interface CreateInvoiceResponse { invoice: Invoice }

// POST /api/projects/:projectId/invoices/from-proposal
export interface CreateInvoiceFromProposalRequest {
  proposalId: string
}
export interface CreateInvoiceFromProposalResponse { invoice: Invoice }

// PATCH /api/invoicing/invoices/:id
export interface UpdateInvoiceRequest {
  status?: InvoiceStatus
  lines?: InvoiceLine[]
  taxCents?: number
  issueDate?: number
  dueDate?: number
  notes?: string
}
export interface UpdateInvoiceResponse { invoice: Invoice }

// POST /api/invoicing/invoices/:id/payments
export interface RecordPaymentRequest {
  amountCents: number
  paidAt: number
  method: Payment['method']
  reference?: string
  notes?: string
}
export interface RecordPaymentResponse { payment: Payment; invoice: Invoice }

// QBO endpoints — full contracts in v2-business-flow.md#qbo-endpoint-contract.
// Mirrored here for the client.
export interface PushInvoiceRequest { force?: boolean }
export interface PushInvoiceResponse {
  qboId: string
  syncStatus: 'synced'
  lastSyncedAt: string
  qboDocNumber: string
}
// 409 NOT_CONNECTED | DRIFT | INVOICE_NOT_ISSUED ; 502 QBO_ERROR { qboStatus, qboMessage }

export interface PullInvoiceResponse {
  syncStatus: 'synced' | 'drift'
  lastSyncedAt: string
  driftFields?: string[]
}
// 404 NOT_PUSHED ; 409 NOT_CONNECTED ; 502 QBO_ERROR

export interface ReconcileRequest {
  strategy: 'keep_local' | 'accept_qbo' | 'merge'
  merged?: Record<string, unknown>     // required when strategy='merge'
}
export interface ReconcileResponse {
  syncStatus: 'synced'
  lastSyncedAt: string
  resolution: 'keep_local' | 'accept_qbo' | 'merge'
}
// 409 NOT_IN_DRIFT | NOT_CONNECTED ; 422 INVALID_MERGE ; 502 QBO_ERROR

export type QboStatusResponse = QboConnection
// Always 200 — disconnected is `{ connected: false }`

// GET /api/integrations/qbo/connect → 302 to QBO authorize URL
// GET /api/integrations/qbo/callback → 302 back to /settings?tab=integrations&qbo=connected|error

export interface DisconnectQboResponse { ok: true }
// 404 NOT_CONNECTED

// GET /api/projects/:id/budget
export type ProjectBudgetResponse = ProjectBudget

// GET /api/invoicing/invoices/:id/download/:format  — pdf invoice, when Pandoc
//   is available (mirrors the proposals download flow)
```

> Note: existing routes live under `/api/v1/...`. Phase 5 normalises to `/api/invoicing/*` (matches ADR-0007 and v2-business-flow's QBO contract section). Tracked as P5P1.

---

## 3. TanStack Query cache keys

```ts
export const queryKeys = {
  // … existing …
  invoices: {
    all: () => ['invoices'] as const,
    list: (opts?: ListInvoicesQuery) => ['invoices', 'list', opts ?? {}] as const,
    detail: (id: string) => ['invoices', 'detail', id] as const,
  },
  qbo: {
    status: () => ['qbo', 'status'] as const,
  },
} as const
```

**Mutation → invalidation:**

| Mutation | Invalidates |
|---|---|
| `useCreateInvoice(projectId)` | `invoices.list()`, `projects.detail(projectId)`, `projects.budget(projectId)` |
| `useUpdateInvoice(id)` | `invoices.list()`, `invoices.detail(id)`, `projects.detail(<owning>)`, `projects.budget(<owning>)` |
| `useRecordPayment(invoiceId)` | `invoices.detail(invoiceId)`, `invoices.list()`, `projects.budget(<owning>)` |
| `usePushInvoice(id)` | `invoices.detail(id)`, `invoices.list()`, `qbo.status()` |
| `usePullInvoice(id)` | same as push |
| `useReconcile(id)` | same as push |
| `useDisconnectQbo()` | `qbo.status()`, `invoices.list()` (sync badges change) |

**WS → cache invalidation:**

| Event | Invalidates |
|---|---|
| `invoice.created`, `invoice.issued`, `invoice.paid`, `invoice.voided` | `invoices.list()`, `invoices.detail(invoiceId)`, `projects.detail(projectId)`, `projects.budget(projectId)` |
| `payment.recorded` | `invoices.detail(invoiceId)`, `projects.budget(projectId)` |
| `qbo.invoice_pushed`, `qbo.invoice_pulled`, `qbo.drift_detected`, `qbo.sync_failed` | `invoices.detail(invoiceId)`, `invoices.list()`, `qbo.status()` |
| `qbo.connected`, `qbo.disconnected` | `qbo.status()` |

---

## 4. Zustand additions

No new global store. The Connection banner reads `useQboStatus()` directly; QBO drift state lives in the per-invoice detail query.

A small derived hook `usePandocAvailable()` reads `health.capabilities.pandoc` — used by both Proposals (Phase 4) and Invoicing (download menus). Lives in `lib/` to be reusable.

---

## 5. Component prop signatures

### 5.1 List route

```ts
// InvoicingRoute.tsx — /invoicing
// No props. Reads ?filter= from URL.

// components/InvoiceListRow.tsx
interface InvoiceListRowProps {
  invoice: Invoice
  isActive: boolean
}

// components/InvoiceKpiStrip.tsx
interface InvoiceKpiStripProps {
  outstandingCents: number
  overdueCents: number
  driftCount: number
  syncFailedCount: number
  activePillId: string | null
  onPillClick(id: string | null): void
}

// components/ConnectionBanner.tsx
interface ConnectionBannerProps {
  qbo: QboConnection
}
// Renders only when !qbo.connected OR (qbo.tokenExpiresAt < now)
// Body: "QuickBooks is disconnected. Push & pull are paused. <Reconnect> in Settings."
// Reconnect link → /settings?tab=integrations
```

### 5.2 Detail route

```ts
// InvoiceDetailRoute.tsx — /invoicing/:id
// No props. Reads :id from URL.

// components/InvoiceHeader.tsx
interface InvoiceHeaderProps {
  invoice: Invoice
}
// Hosts <StatusActionButton> with the state machine:
//   Draft → Issue (Mark issued)
//   Issued → Mark partially paid / Mark paid / Void
//   Partially paid → Mark paid / Void
//   Paid → no primary (read-only); ▾ Void
//   Void → no primary (read-only)

// components/LineItemsTable.tsx
interface LineItemsTableProps {
  lines: InvoiceLine[]
  readOnly: boolean                    // true when status ∈ {paid, void}
  onLineChange(index: number, update: Partial<InvoiceLine>): void
  onLineAdd(): void
  onLineRemove(index: number): void
}

// components/PaymentsSection.tsx
interface PaymentsSectionProps {
  invoice: Invoice
}
// Renders payment rows + `+ Record payment` button that opens RecordPaymentDialog

// components/RecordPaymentDialog.tsx
interface RecordPaymentDialogProps {
  invoiceId: string
  open: boolean
  onOpenChange(open: boolean): void
  maxAmountCents: number               // suggests invoice balance
}

// components/SyncSection.tsx
interface SyncSectionProps {
  invoice: Invoice
  qbo: QboConnection
  drift: InvoiceDrift | null
}
// Shows: synced timestamp, qboId, qboDocNumber, lastError
// Buttons: Push to QBO (disabled when !connected), Pull from QBO (disabled when !qboId)
// When drift !== null, expands to render <DriftBlock>
```

### 5.3 Drift block

```ts
// components/DriftBlock.tsx
interface DriftBlockProps {
  drift: InvoiceDrift
  onResolve(req: ReconcileRequest): void
}
// Renders side-by-side diff. Each diverging field is a row with:
//   <field-name>   <local value>    <qbo value>
//                  (highlighted)    (highlighted)
// Primary buttons:
//   Keep local (push)  → onResolve({ strategy: 'keep_local' })
//   Accept QBO (pull)  → onResolve({ strategy: 'accept_qbo' })
//   Custom merge       → opens <MergePicker>
// <Use agent ▸> link spawns the reconcile-drift skill (inline session stream)

// components/MergePicker.tsx
interface MergePickerProps {
  drift: InvoiceDrift
  onCommit(merged: Record<string, unknown>): void
  onCancel(): void
}
// Per-field radio: Local / QBO; the chosen values are bundled into `merged`
```

### 5.4 Settings → QBO panel

```ts
// QboIntegrationPanel.tsx
// No props. Reads ?qbo=connected|error from URL on mount, shows a toast accordingly.
// Renders one of two states:
//   - Not connected: explainer + <a href="/api/integrations/qbo/connect">Connect</a>
//   - Connected: company name, realmId (last 4), connected since, expiry,
//     lastPushAt, lastPullAt, <Disconnect> button (red, with AlertDialog confirm),
//     lastError (collapsible) if present
```

### 5.5 Status enums → visual map

```ts
const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: string }> = {
  draft:           { label: 'Draft',           tone: 'bg-zinc-200 text-zinc-700' },
  issued:          { label: 'Issued',          tone: 'bg-indigo-100 text-indigo-800' },
  partially_paid:  { label: 'Partially paid',  tone: 'bg-amber-100 text-amber-800' },
  paid:            { label: 'Paid',            tone: 'bg-emerald-100 text-emerald-800' },
  void:            { label: 'Void',            tone: 'bg-zinc-100 text-zinc-400 line-through' },
}

const SYNC_STATUS: Record<SyncStatus, { label: string; tone: string }> = {
  not_pushed:  { label: 'Local only',  tone: 'text-muted' },
  pending:     { label: 'Sync pending', tone: 'bg-zinc-100 text-zinc-700' },
  synced:      { label: '↻ Synced',     tone: 'bg-emerald-50 text-emerald-700' },
  drift:       { label: '⚠ Drift',     tone: 'bg-amber-100 text-amber-800' },
  failed:      { label: '✗ Sync failed', tone: 'bg-rose-100 text-rose-800' },
}
```

---

## 6. URL schema

| Route | Search params |
|---|---|
| `/invoicing` | `?filter=<status>`, `?sync=<syncStatus>`, `?search=` |
| `/invoicing/:id` | none |
| `/settings?tab=integrations` | `?qbo=connected\|error&reason=<code>` (set by OAuth callback redirect) |
| `/projects/:id?tab=invoices` | inherits Phase 2 routing |

OAuth lifecycle: the user clicks Connect → server redirects to QBO → user authorises → QBO redirects to `/api/integrations/qbo/callback` → server redirects to `/settings?tab=integrations&qbo=connected`. The Integrations tab reads the `?qbo=` param on mount and shows a toast (then strips the param).

---

## 7. Backend route gaps

| # | Route / Component | Reason |
|---|---|---|
| P5P1 | Alias `/api/v1/{projects/:pid/invoices,invoices/:id,…}/*` → `/api/invoicing/*` paths | ADR-0007 + symmetry |
| P5P2 | `GET /api/invoicing/invoices` (cross-project list) | Current routes are project-scoped only |
| P5P3 | `src/storage/secret-vault.ts` encryption helper | DPAPI when `process.platform === 'win32'`; AES-GCM with `QBO_TOKEN_KEY` env var otherwise. Used by qbo_connection token storage |
| P5P4 | `qbo_connection` table migration | Single-row enforced via `CHECK (id = 1)`; columns per v2-business-flow §Token storage |
| P5P5 | `POST /api/invoicing/invoices/:id/push` | Per the v2-business-flow QBO contract |
| P5P6 | `POST /api/invoicing/invoices/:id/pull` | Per the v2-business-flow QBO contract |
| P5P7 | `POST /api/invoicing/invoices/:id/reconcile` | Per the v2-business-flow QBO contract |
| P5P8 | `GET /api/invoicing/qbo/status` | Drives the banner + Integrations panel |
| P5P9 | `GET /api/integrations/qbo/connect` (302 to QBO authorize URL) | OAuth2 PKCE start |
| P5P10 | `GET /api/integrations/qbo/callback` (302 back to SPA) | OAuth code exchange + token storage |
| P5P11 | `POST /api/integrations/qbo/disconnect` | Best-effort QBO revoke + local clear |
| P5P12 | QBO pull scheduler (15-minute default, configurable via env) | Uses Phase 1 scheduler primitive. Compares each changed QBO invoice with local; flags drift |
| P5P13 | `GET /api/invoicing/invoices/:id/download/:format` (markdown / PDF) | Local copy when needed; Pandoc-optional |
| P5P14 | Audit + events wiring: `module='invoicing'`, action in `{ invoice.push, invoice.pull, invoice.reconcile, qbo.connect, qbo.disconnect }`, project_id resolved from invoice → proposal → project chain | Per v2-business-flow §Audit + events |
| P5P15 | `GET /api/projects/:id/budget` returns real values from the `project_budget` view (Phase 2 returned zeros) | Connects Phase 2 budget plumbing |

---

## 8. Phasing within Phase 5

The heaviest phase — order matters because QBO work blocks the panel's marquee features.

1. **P0 — Backend invoice route normalisation + cross-project list** (P5P1-P5P2)
2. **P1 — Invoice list + detail (local-only first)** — list, KPI strip, detail layout, line items, payments. Phase 5 is shippable here even without QBO
3. **P2 — Secret vault + qbo_connection schema** (P5P3-P5P4)
4. **P3 — QBO OAuth flow** (P5P9, P5P10, P5P11 + Integrations panel UI)
5. **P4 — QBO push** (P5P5 + UI button)
6. **P5 — QBO pull + drift detection** (P5P6 + scheduled poller P5P12)
7. **P6 — Drift reconciliation UI + reconcile route** (P5P7 + DriftBlock + MergePicker)
8. **P7 — `reconcile-drift` skill** (agent-as-escape; reuses inline session stream)
9. **P8 — Project Invoices tab + budget rollup** (replaces Phase 2 placeholder; wires real project_budget view)
10. **P9 — Polish + agent QA** (status badge consistency, error toasts, Pandoc download menu)

Realistic estimate: **10-14 days** for a focused contributor. The v2-business-flow's "2-3 weeks" matches — this is the heaviest phase by code volume.

---

## 9. Security notes

The QBO integration handles real money flows and OAuth tokens. The spec carries these guarantees forward:

- **Tokens never appear in logs, audit entries, or events.** Only `realmId` (last 4 chars surface in UI) and `companyName` are loggable. The audit rows for `invoice.push` / `invoice.pull` carry `target_id=invoice.id` and the diff summary — no auth material.
- **DPAPI on Windows; AES-GCM with operator-provided `QBO_TOKEN_KEY` elsewhere.** Without `QBO_TOKEN_KEY` set on a non-Windows host, the server refuses to start the QBO flow (errors with `QBO_TOKEN_KEY_MISSING`).
- **OAuth state parameter** — server-generated, one-time, 5-minute TTL, stored in-memory. Callback rejects on mismatch.
- **Single-user trust model** — the app binds to `127.0.0.1` by default; the QBO callback succeeds only when the redirect URI matches what's registered with QBO (operator configures it once during app setup).
- **No webhook ingestion** — out per v2. Polling is the only inbound sync mechanism. Removes "public webhook receiver" as an attack surface.

---

## 10. What this spec does NOT pin

- **Multi-company QBO** — schema deferred (every invoice would gain `realm_id` FK).
- **Auto-push-on-issue** — manual push only.
- **Webhook ingestion** from QBO.
- **Time-tracking integration** — future `modules/time-tracking/`.
- **Milestone-based billing tab** in the New Invoice dialog — future skill drops in via dynamic action discovery (Phase 1.5 P2S1).
- **Multi-currency invoices** — QBO supports it but the v2 schema is single-currency.
- **Recurring invoices** — out per v2 (operator creates one-off invoices).

---

## 11. Cross-references

- Phase 5 punch list: [`./phase-5-invoicing-punchlist.md`](./phase-5-invoicing-punchlist.md)
- Domain spec + QBO contract: [`./v2-business-flow.md#modulesinvoicing`](./v2-business-flow.md#modulesinvoicing), [`./v2-business-flow.md#qbo-endpoint-contract`](./v2-business-flow.md#qbo-endpoint-contract)
- Phase 2 (Projects, budget plumbing): [`./phase-2-projects-impl-spec.md`](./phase-2-projects-impl-spec.md)
- Phase 4 (Proposals → invoices `from-proposal`): [`./phase-4-proposals-impl-spec.md`](./phase-4-proposals-impl-spec.md)
- Phase 1.5 conventions: [`./phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md)
- ADRs: [`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md), [`../adr/0007-module-panel-conventions.md`](../adr/0007-module-panel-conventions.md)
- Server-side: [`../../modules/invoicing/`](../../modules/invoicing/)

---
name: invoicing
description: Invoices, payments, QBO sync, and budget rollup. The `project_budget` view is the canonical source for the project header's budget chip; QBO push/pull keeps a single-realm QuickBooks Online company in sync.
version: 0.2.0
depends_on:
  - projects
  - proposals
events:
  - invoice.created
  - invoice.issued
  - invoice.paid
  - invoice.voided
  - payment.recorded
  - qbo.invoice_pushed
  - qbo.invoice_pulled
  - qbo.drift_detected
  - qbo.sync_failed
  - qbo.connected
  - qbo.disconnected
---

# Invoicing

Local invoice + payment records plus QuickBooks Online sync. The
`project_budget` SQL view is the canonical source the project header /
list KPI strip reads.

Invoice numbering is **local-owned**: `<project.number>-<seq>` (e.g.
`25001-01`, `25001-02`). QBO's own doc number is recorded as
informational only — local numbers stay stable across sync direction.

`project_budget` is a VIEW, not a table — always reflects the current
state of accepted estimates + non-void invoices + recorded payments. No
cache invalidation.

## QBO sync

Single-realm (single-company) only in v2; the wiring lives at
[`src/modules/qbo/`](../../src/modules/qbo/) and is mounted onto the
Invoicing routes when the operator sets `QBO_CLIENT_ID` /
`QBO_CLIENT_SECRET` (and a viable vault key). Without those, the
push/pull/reconcile/connect/callback routes return 503 and the panel
shows a "Connect QBO" banner.

- **Push** — explicit per-invoice, idempotent over the local `id`.
  Emits `qbo.invoice_pushed` on success, `qbo.sync_failed` on the
  upstream-error path.
- **Pull** — scheduled poller (15 min default), or per-invoice on demand.
  Sets `sync_status='drift'` on divergence and emits
  `qbo.drift_detected`; non-drift pulls emit `qbo.invoice_pulled`.
- **Reconcile** — UI-first via the drift block, agent-as-escape via the
  `reconcile-drift` Skill. Both paths land on the same
  `POST /api/v1/invoices/:id/reconcile` endpoint.
- **Tokens** — stored encrypted in the single-row `qbo_connection`
  table via `src/storage/secret-vault.ts` (Windows DPAPI when
  available, AES-GCM with `QBO_TOKEN_KEY` otherwise). Refresh tokens
  auto-refresh on next call.

Schema lives at
[`schema/001_init.sql`](./schema/001_init.sql) (invoice / invoice_line /
payment + `project_budget` view) and
[`schema/002_qbo.sql`](./schema/002_qbo.sql) (qbo_connection +
sync columns on invoice).

See [v2-business-flow.md](../../docs/planning/v2-business-flow.md#modulesinvoicing)
and [[adr-0004-modules-as-second-extensibility-primitive]].

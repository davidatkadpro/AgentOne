---
name: invoicing
description: Invoices, payments, and budget rollup. Local-only in v0.1; QBO push/pull deferred. The `project_budget` view is the canonical source for the project header's budget chip.
version: 0.1.0
depends_on:
  - projects
  - proposals
events:
  - invoice.created
  - invoice.issued
  - invoice.paid
  - invoice.voided
  - payment.recorded
---

# Invoicing

Local invoice + payment records and the `project_budget` SQL view that
the project header / list KPI strip read. **No QBO integration in v0.1**
— `qbo_connection` table and push/pull machinery are deferred until
operator OAuth is wired up.

Invoice numbering is **local-owned**: `<project.number>-<seq>` (e.g.
`25001-01`, `25001-02`). QBO's own doc number, when sync lands, will be
recorded as informational only.

`project_budget` is a VIEW, not a table — always reflects the current
state of accepted estimates + non-void invoices + recorded payments, no
cache invalidation.

See [v2-business-flow.md](../../docs/planning/v2-business-flow.md#modulesinvoicing)
and [[adr-0004-modules-as-second-extensibility-primitive]].

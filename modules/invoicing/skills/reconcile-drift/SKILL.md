---
name: reconcile-drift
description: Walk through a drifted invoice with the operator — explain each diverging field, recommend a side, then call the reconcile route to resolve.
slash_command: reconcile-drift
label: Reconcile drift
icon: refresh-cw
surface: ask_agent
tabs: []
default_profile: ops
requires_confirmation: false
prompt_template: |
  Invoice {{contextId}} has drifted from QuickBooks. Pull the current drift
  payload via `get_invoice_drift`, walk through each diverging field with
  the operator and recommend a side (keep_local / accept_qbo / merge), then
  call `apply_reconcile` with the chosen strategy. Surface the QBO error
  message verbatim if the call fails.
tools:
  - id: get_invoice_drift
    handler: ./tools/get-invoice-drift.ts
    description: Fetch the latest drift snapshot for an invoice. Returns { driftFields, local, qbo }.
  - id: apply_reconcile
    handler: ./tools/apply-reconcile.ts
    description: POST /api/invoicing/invoices/:id/reconcile with the chosen strategy.
---

# Reconcile drift

When the QBO pull poller (or a manual pull) detects that an invoice has
diverged from QuickBooks, the operator can either resolve it themselves
via the side-by-side diff in `<DriftBlock>`, or escape to this Skill via
the **Use agent ▸** link.

## Workflow

1. Call `get_invoice_drift` to read `{ driftFields, local, qbo }`.
2. Walk the operator through each field. For each field, recommend a side:
   - **`number` / `lineCount`** — almost always `keep_local`; AgentOne is
     the canonical numbering authority.
   - **`total` / `balance`** — depends on whether a real payment landed in
     QBO that AgentOne hasn't recorded yet. Recommend `accept_qbo` only if
     the operator confirms an out-of-band QBO update.
   - **`dueDate`** — recommend whichever side the operator changed most
     recently.
   - **`lines[i].*`** — usually `keep_local`; AgentOne owns the canonical
     line shape per the v2 contract.
3. If every field has a clear side, ask the operator to confirm with
   `request_user_input` ("Resolve with `keep_local` / `accept_qbo` /
   `merge`?").
4. Call `apply_reconcile` with the chosen strategy. For `merge`, pass the
   per-field selections in the `merged` map.

If the apply step fails with a `502 QBO_ERROR`, surface the upstream
`qboMessage` field verbatim — the operator may need to act in QBO first.

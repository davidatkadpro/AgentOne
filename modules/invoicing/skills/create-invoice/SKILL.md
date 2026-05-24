---
name: create-invoice
description: Create a draft invoice for a project — either from an accepted proposal (copies estimate lines) or from scratch with manually-supplied line items.
slash_command: create-invoice
label: Create invoice
icon: file-plus
surface: both
tabs: []
default_profile: ops
requires_confirmation: false
prompt_template: |
  Create a draft invoice for project {{project.number}}. If the project has
  an accepted proposal, use `create_invoice_from_proposal` to copy its lines.
  Otherwise, gather the line items from the operator and call `create_invoice`.
tools:
  - id: create_invoice_from_proposal
    handler: ./tools/create-invoice-from-proposal.ts
    description: Copy an accepted proposal's estimate lines into a new draft invoice. Most common path for fixed-fee AEC work.
  - id: create_invoice
    handler: ./tools/create-invoice.ts
    description: Create a draft invoice with manually-supplied line items.
---

# Create invoice

Make a draft invoice. The invoice starts in `draft` status — issuing it
is a separate explicit action (`PATCH /api/v1/invoices/:id/status` with
`{status: "issued"}`) so the operator can review the rendered output
first.

## Workflow

1. **Pick a path.** If the project has an `accepted` proposal, use
   `create_invoice_from_proposal` — that copies the proposal's estimate
   lines verbatim. Otherwise call `create_invoice` with manual lines.
2. **Pick a due date** (optional, milliseconds epoch). Standard practice
   is net-30 from today.
3. **Add tax** if the project requires it (`tax_amount`, flat number).
4. **Report the invoice number + total** to the operator. They issue
   it from the UI when ready.

Invoice numbering is local: `<project.number>-<seq>` (e.g. `25001-01`).
The seq increments per project across all invoices, voided or not.

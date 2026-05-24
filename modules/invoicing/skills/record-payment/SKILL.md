---
name: record-payment
description: Record a payment against an open invoice. Auto-flips the invoice to partial / paid based on the running total.
slash_command: record-payment
label: Record payment
icon: credit-card
surface: ask_agent
tabs: []
default_profile: ops
requires_confirmation: false
prompt_template: |
  Record a payment against invoice {{contextId}}. Ask the operator for the
  amount, method, and any reference number, then call `record_payment`.
tools:
  - id: record_payment
    handler: ./tools/record-payment.ts
    description: Insert a payment row and update the invoice's amount_paid + status.
---

# Record payment

When a client pays — check, ACH, card, wire, cash — record the payment
against the invoice. The service auto-updates `amount_paid` and the
invoice's status:

- `amount_paid < total` → `partial`
- `amount_paid >= total` → `paid` (stamps `paid_at`)

## Workflow

1. **Identify the invoice.** If the operator gave a number (`25001-02`),
   call `list_invoices_for_project` (a future tool) or browse via the
   HTTP route. For this Skill, the agent needs the invoice id directly.
2. **Call `record_payment`** with `invoice_id`, `amount`, optionally
   `method`, `reference`, `notes`. `received_at` defaults to now.
3. **Confirm the new status** so the operator knows whether anything is
   still outstanding.

Recording a payment on a `void` invoice fails — void invoices are dead.

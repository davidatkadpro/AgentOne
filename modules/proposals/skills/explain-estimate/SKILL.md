---
name: explain-estimate
description: Walk the operator through an estimate's line items and recommend whether the breakdown looks right.
slash_command: explain-estimate
label: Explain estimate
icon: book-open
surface: ask_agent
tabs: []
default_profile: ops
requires_confirmation: false
prompt_template: |
  Explain the estimate behind {{contextId}}. Read the line items, summarise
  the overall split (fixed-fee vs time-and-materials), call out anything
  that looks underspecified, and offer a one-paragraph rationale the
  operator can paste into a follow-up email if useful.
---

# Explain estimate

Read-only agent walkthrough. Useful when the operator inherits an estimate
from someone else (or from an old `build-estimate` run) and wants a quick
sanity check before issuing the proposal.

## Workflow

1. The dispatch route auto-injects the artifact id as `contextId`. Use it
   to look up the artifact via the proposals service.
2. Read each line item. Group by `kind` (fixed / time-and-materials / unit).
3. Surface anything that looks off:
   - Very large fixed-fee lines without a description.
   - Time-and-materials lines with no unit or qty.
   - Lines whose `lineTotal` doesn't match `qty * unitPrice` (data drift).
4. Finish with a 2-3 sentence summary the operator can lift into a reply
   to the client.

No tools — this skill is a structured prompt only.

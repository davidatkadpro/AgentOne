---
name: build-estimate
description: Read a project's scope.md (written by the email scope-extractor) and turn it into a draft estimate — pricing kinds per line, calling create_estimate when the lines are ready.
slash_command: build-estimate
label: Build estimate from scope
icon: file-plus
surface: both
tabs: []
default_profile: default
requires_confirmation: false
prompt_template: |
  Build a draft estimate for project {{contextId}} from scope file `{{args.scopeFilePath}}`.
  Template hint: {{args.templateName}}.
tools:
  - id: create_estimate
    handler: ./tools/create-estimate.ts
    description: Insert a draft estimate with line items. Each line declares its kind (fixed | time_and_materials | unit).
---

# Build estimate

Turn a scope.md (or operator-provided notes) into a draft Estimate row
with line items. The Estimate is the input to `generate-proposal`.

## Workflow

1. **Get the scope.** Use the `read_document` Core Tool to read
   `projects/<n>/in/<dated>/scope.md`. The file's frontmatter lists
   `client`, `project_type`, `phases`, `assumptions`, `exclusions` — read
   them so the line items line up with the declared phases.
2. **Decide pricing kinds.** Each line item has a `kind`:
   - `fixed` — flat-fee deliverables (most design phases land here)
   - `time_and_materials` — hourly with a `qty` cap or estimate
   - `unit` — per-thing (per door, per sf, per audit) with a `unit` label
3. **Call `create_estimate`** with `project_id`, the `lines` array, and
   `source_scope_path` pointing at the scope.md file. If pricing requires
   operator input (target budget, hourly rate, scope clarification), use
   the `request_user_input` Core Tool before calling create_estimate.
4. **Tell the operator** the estimate id + total so they can review.

Don't issue a proposal here — that's `generate-proposal`'s job. This
Skill is the data-entry step.

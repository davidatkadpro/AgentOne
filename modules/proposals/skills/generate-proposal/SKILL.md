---
name: generate-proposal
description: Render a Proposal from a draft Estimate. Picks the next `<project.number>-P<n>` sequence and writes the rendered markdown to `<project>/drafts/proposals/<number>.md`.
slash_command: generate-proposal
tools:
  - id: list_estimates_for_project
    handler: ./tools/list-estimates-for-project.ts
    description: List all estimates for a project so the agent can pick which to proposalize.
  - id: create_proposal
    handler: ./tools/create-proposal.ts
    description: Render the estimate into a markdown proposal and persist the row.
---

# Generate proposal

Take a draft Estimate and produce a Proposal — a numbered, rendered
markdown artifact sitting at `<project>/drafts/proposals/<number>.md`.

## Workflow

1. **Pick the estimate.** Call `list_estimates_for_project` and look for
   the most recent `draft` or `ready` estimate. If multiple candidates
   look reasonable, call `request_user_input` to ask which one. Don't
   proposalize accepted/rejected/superseded estimates — they're done.
2. **Call `create_proposal`** with `project_id` and `estimate_id`. The
   tool picks the next `<project.number>-P<seq>` number and writes the
   rendered markdown.
3. **Tell the operator** the proposal number + path. They open the file,
   edit if needed, then mark the proposal `issued` from the UI (or via
   a future Skill).

The Proposal starts in `draft` status. `issued` is an explicit operator
action, not something this Skill takes.

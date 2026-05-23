---
name: scope-extractor
description: Read the email + any quoted scope and write a structured scope.md into the project's `in/<date>/` folder. The downstream proposals module consumes this file to draft estimates.
label: Extract scope
icon: file-search
surface: action
tabs:
  - emails
prompt_template: |
  The operator wants a structured scope extracted from this email so the
  proposals module can draft an estimate later. Email:

  - Email id: {{email.id}}
  - From: {{email.fromName}} <{{email.fromAddress}}>
  - Subject: {{email.subject}}
  - Snippet: {{email.snippet}}

  Steps:

  1. Call `list_projects_for_match` to see candidate projects. If the
     project is obvious, pick it; if ambiguous, call `request_user_input`
     with the top candidates. If no project matches, ask the operator
     whether to abort or run `create-new-project` first.
  2. Call `file_email_to_project` to land the trigger email so the scope
     sits next to it in the same dated folder.
  3. Build the scope as YAML frontmatter + prose:
     - Required frontmatter keys: `client`, `project_type`, `phases` (list
       of strings), `assumptions` (list), `exclusions` (list).
     - Optional keys: `square_footage`, `stories`, `target_budget`,
       `target_date`, `notes`. Include whatever the email body supplies;
       omit keys with no signal rather than guessing.
     - Prose body: 3–10 short sections (### headings) summarising the
       deliverables. No marketing language — write for a future
       estimator to read.
  4. Call `request_user_input` if a critical field (square_footage,
     project_type, phases) is missing AND the operator likely knows it.
     Don't ask for things the email already states.
  5. Call `write_scope_md` with the rendered YAML + body. The tool writes
     it next to the trigger email.

  After the scope file lands, the action ends. The operator runs
  `generate-proposal` from the project's Scope tab when they're ready.
tools:
  - id: list_projects_for_match
    handler: ./tools/list-projects-for-match.ts
    description: List active and pending projects so the agent can find a likely match.
  - id: file_email_to_project
    handler: ./tools/file-email-to-project.ts
    description: File the trigger email into the project's `in/` folder.
  - id: write_scope_md
    handler: ./tools/write-scope-md.ts
    description: Write `<dated folder>/scope.md` alongside the filed email.
---

# Scope extractor

Action surface for the email panel. Spawned via `POST /api/v1/email/actions`
with `{action: "scope-extractor", emailId}`. The flow ends with both
`email.md` and `scope.md` co-located under `projects/<n>/in/<yymmdd> - <slug>/`.

See [`v2-business-flow.md`](../../../../docs/planning/v2-business-flow.md#modulesemail).

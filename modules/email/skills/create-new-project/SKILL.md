---
name: create-new-project
description: Create a new project from this email — pick a number, pick a name, then file the email into the new project's `in/` folder so it's preserved as the trigger document.
label: Create new project
icon: folder-plus
surface: action
tabs:
  - emails
prompt_template: |
  The operator wants to start a new project from this email. Email:

  - Email id: {{email.id}}
  - From: {{email.fromName}} <{{email.fromAddress}}>
  - Subject: {{email.subject}}
  - Snippet: {{email.snippet}}

  Steps:

  1. Call `suggest_next_project_number` to see the next free number in the
     operator's preferred format. The suggestion is editable.
  2. Propose a short project name and (if extractable) a client. If the
     subject is vague, call `request_user_input` with your best guess and
     let the operator confirm.
  3. Call `create_project` with `{number, name, client?, description?}`.
  4. Call `file_email_to_project` with the new `projectId` and a one
     paragraph `body` summarising why this project exists.

  Keep names short (≤ 60 chars). Strip RFC prefixes ("Re:", "Fwd:") from
  the name; that's an email artifact, not a project name.
tools:
  - id: suggest_next_project_number
    handler: ./tools/suggest-next-project-number.ts
    description: Return the next free project number (default YY###) based on existing projects.
  - id: create_project
    handler: ./tools/create-project.ts
    description: Create a new project row. Throws if the number is already in use.
  - id: file_email_to_project
    handler: ./tools/file-email-to-project.ts
    description: Write the trigger email's summary into the project's `in/<yymmdd> - <slug>/email.md`.
---

# Create new project

Action surface for the email panel. Spawned via `POST /api/v1/email/actions`
with `{action: "create-new-project", emailId}`. The flow ends with the
trigger email filed under the new project — same convention as
file-to-project, just adding a project-creation step before the file.

See [`v2-business-flow.md`](../../../../docs/planning/v2-business-flow.md#modulesemail).

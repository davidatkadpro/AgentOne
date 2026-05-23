---
name: file-to-project
description: File this email summary + attachments into a project's `in/<yymmdd> - <slug>/` folder. Match a project by client name or project number; if ambiguous, ask the user.
label: File to project
icon: folder-input
surface: action
tabs:
  - emails
prompt_template: |
  You are filing an email into a project's `in/` folder so the operator can
  reference it later. The email:

  - Email id: {{email.id}}
  - From: {{email.fromName}} <{{email.fromAddress}}>
  - Subject: {{email.subject}}
  - Snippet: {{email.snippet}}

  Steps:

  1. Call `list_projects_for_match` to see candidate projects (active /
     pending only).
  2. If exactly one is a clear match (subject or client name overlap), call
     `file_email_to_project` with that `projectId` and a one-paragraph
     `body` summarising the email.
  3. If multiple candidates look reasonable, call `request_user_input` with
     a question naming the top candidates so the operator picks. After they
     reply, file the email under their chosen project.
  4. If no project matches, call `request_user_input` to ask whether to
     create a new project first (the operator can run `/create-project`).
tools:
  - id: list_projects_for_match
    handler: ./tools/list-projects-for-match.ts
    description: List active and pending projects so the agent can find a likely match.
  - id: file_email_to_project
    handler: ./tools/file-email-to-project.ts
    description: Write the email summary into the project's `in/<yymmdd> - <slug>/email.md`.
---

# File to project

Action surface for the email panel. Spawned via `POST /api/v1/email/actions`
with `{action: "file-to-project", emailId}`. The dispatcher renders the
prompt_template above against the email's frontmatter row and seeds a new
session that runs through the steps.

The deterministic write happens in `file_email_to_project`; the agent's job
is the project-matching judgment call and the user prompt if matching is
ambiguous. See [`v2-business-flow.md`](../../../../docs/planning/v2-business-flow.md#modulesemail).

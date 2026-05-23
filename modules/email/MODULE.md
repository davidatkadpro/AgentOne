---
name: email
description: Light email triage surface — indexes messages from an EmailSource and exposes actions (file-to-project, create-new-project, scope-extractor) without becoming a mail client.
version: 0.1.0
depends_on:
  - projects
events:
  - email.received
  - email.read
  - email.filed
  - email.action_started
  - email.action_completed
---

# Email

A light email triage surface. **Not** a mail client replacement.

The local `email` table is an *index* of messages known to AgentOne — bodies
and attachments live in the source (Maildir folder or Microsoft Graph) until
the email is filed to a project, at which point a summary markdown + copies of
the attachments land under `projects/<n>/in/<yymmdd> - <slug>/`.

Sources implement the `EmailSource` interface: `list`, `get`, `markRead`,
`fetchAttachment`. No outbound mail in v2.

See [v2-business-flow.md](../../docs/planning/v2-business-flow.md#modulesemail)
and [[adr-0004-modules-as-second-extensibility-primitive]].

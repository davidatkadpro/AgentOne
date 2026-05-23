---
name: list-projects
description: List existing projects. Filter by status (pending/active/blocked/completed/cancelled). Returns id, number, name, client, status, and updated_at for each row.
tools:
  - id: list_projects
    handler: ./tools/list-projects.ts
    description: List projects via the projects module. Newest-first. Optional status filter; optional limit (default 50).
slash_command: list-projects
---

# List Projects

Use to look up projects by status or to enumerate the working set. Default
returns newest-first up to the limit.

## Optional

- `status` — array of statuses to include (e.g. `["pending", "active"]`).
  Omit for all statuses.
- `limit` — max rows; default 50, hard ceiling 500.

## Tip

Project numbers are stable operator-facing identifiers — preferred over UUID
ids when the user references projects in chat.

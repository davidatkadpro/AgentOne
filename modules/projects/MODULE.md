---
name: projects
description: Project, phase, and task records — the central domain every other module references.
version: 0.2.0
events:
  - project.created
  - project.updated
  - project.completed
  - phase.created
  - phase.completed
  - task.created
  - task.updated
  - task.completed
  - task.blocked
  - task.file_attached
  - task.file_detached
---

# Projects

The central Module. Owns `project`, `phase`, `task`, and `task_dependency`
tables. Other Modules (email, proposals, invoicing) reference project IDs and
declare `depends_on: [projects]` so this Module's migrations always run first.

Uniform status enum (`pending | active | blocked | completed | cancelled`)
across project/phase/task. Every row carries a `metadata_json` column for
ad-hoc extension without migrations.

`project.number` is the operator-facing short identifier (default format
`YY###`, e.g. `24001`). Project folder names follow `<number> - <slug>` under
the SharePoint `projects/` tree.

See [v2-business-flow.md](../../docs/planning/v2-business-flow.md#modulesprojects)
and [[adr-0004-modules-as-second-extensibility-primitive]].

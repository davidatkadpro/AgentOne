---
name: add-task
description: Add a task to a phase within a project. Supports subtasks (parent_task_id) and assignment to a specific agent profile. Status defaults to "pending".
tools:
  - id: add_task
    handler: ./tools/add-task.ts
    description: Insert a new task under a phase. Validates that the phase belongs to the given project. Subtask via parent_task_id.
slash_command: add-task
---

# Add Task

Adds work items to a project. Every task must belong to a phase; the phase
itself must belong to the project. Use `add-phase` first if no phases exist.

## Required

- `project_id` — UUID of the project.
- `phase_id` — UUID of the phase; must belong to `project_id`.
- `title` — short task title.

## Optional

- `description` — markdown body.
- `parent_task_id` — make this a subtask of another task.
- `assignee_profile` — agent profile id the task is assigned to (e.g.
  `drafter`, `estimator`). Used when an action like the email scope-extractor
  generates work that should be picked up by a specific role.
- `metadata` — ad-hoc JSON for fields the schema doesn't model.

## What happens

- Row inserted in `task` with status='pending' and a new auto-position
  (positions are tracked per phase + parent independently).
- `task.created` event emitted; audit row written.

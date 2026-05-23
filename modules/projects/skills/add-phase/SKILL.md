---
name: add-phase
description: Add a phase to an existing project. Phases group tasks and are the mandatory parent for any task (no orphan tasks). Position auto-increments per project.
tools:
  - id: add_phase
    handler: ./tools/add-phase.ts
    description: Insert a new phase under a project. Status defaults to "pending"; position auto-assigned to the next slot.
slash_command: add-phase
---

# Add Phase

Phases divide a project's tasks (e.g. AEC: `SD / DD / CD / CA`). Tasks must
belong to a phase — add the phase first.

## Required

- `project_id` — the UUID of the project to add to.
- `name` — short label (`SD`, `Schematic Design`, etc.).

## Optional

- `metadata` — ad-hoc JSON for fields the schema doesn't model yet.

## What happens

- Row inserted in `phase` with status='pending' and a new auto-position.
- `phase.created` event emitted; audit row written.

---
name: create-project
description: Create a new Project record. Requires a unique project number and a name. Optional client, description, folder path, and metadata. Returns the created project's id and number.
tools:
  - id: create_project
    handler: ./tools/create-project.ts
    description: Insert a new project into modules/projects. Number must be unique; collisions return TOOL_VALIDATION. The project folder under <storage-root>/projects/<number> - <name>/ is created eagerly.
slash_command: create-project
---

# Create Project

Use this skill when the user (or another skill) wants to register a new
project — typically as the first step of `file-to-project`, `scope-extractor`,
or a manual `+ New project` action.

## Required

- `number` — the operator-facing short identifier. Default format `YY###`
  (e.g. `24001`). Must be unique system-wide; collisions surface as
  `TOOL_VALIDATION` so you can ask the user for the right number.
- `name` — short descriptive name. Used in the folder slug.

## Optional

- `client` — primary stakeholder / owner.
- `description` — what the project is about.
- `folder_path` — override the default `projects/<number> - <name>/` layout
  (rare — the default is right for AEC projects).
- `metadata` — arbitrary JSON; use for ad-hoc fields the schema doesn't model
  yet (per the three-ring extension model in
  [[adr-0004-modules-as-second-extensibility-primitive]]).

## What happens

1. Row inserted in `project` (status='pending', timestamps set).
2. Folder tree created on the storage adapter: `<folderPath>/in/` and
   `<folderPath>/drafts/`.
3. `project.created` event emitted; audit row written tagged with the
   calling actor.

## When to combine with other actions

- After creation, the natural next step is `add-phase` (the project has no
  phases yet — tasks need a phase). If the user is creating the project as
  part of `file-to-project`, the email module will then file the originating
  email into `<folderPath>/in/<date> - <slug>/`.

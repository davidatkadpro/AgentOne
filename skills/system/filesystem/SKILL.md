---
name: filesystem
description: Read, write, edit, and glob files under the storage root (wiki/ projects/ drafts/). All paths are relative to the storage root.
tools:
  - id: read_file
    handler: ./tools/read-file.ts
    description: Read a UTF-8 text file. Returns content plus mtime and size. Paths are POSIX, relative to the storage root.
  - id: write_file
    handler: ./tools/write-file.ts
    description: Write a UTF-8 text file, overwriting any existing content. Creates parent directories. Refuses binary or out-of-tree paths.
  - id: edit_file
    handler: ./tools/edit-file.ts
    description: Replace exactly one occurrence of a find-string in an existing file. Errors if zero or more than one match.
  - id: glob
    handler: ./tools/glob.ts
    description: List files under a prefix. Returns relative paths, sizes, mtimes. Use this to discover what is on disk before reading.
---

# Filesystem

Use these tools to interact with files in the storage root. Paths are
forward-slash POSIX, relative to the storage root configured at startup.
The storage root is laid out as three sibling trees:

- `wiki/`     — markdown notes you maintain (prefer the dedicated `wiki_*` Core
  Tools over `read_file` / `write_file` here so the wiki index stays in sync)
- `projects/` — stakeholder-authored project Documents (read mostly; do not
  overwrite PDFs or other binaries)
- `drafts/`   — your own non-wiki outputs (proposals, exports, diagrams)

## Conventions

- Always glob a directory before reading individual files when you don't
  already know the layout.
- For markdown work inside `wiki/`, use `wiki_write` / `wiki_append` /
  `wiki_edit` rather than `write_file` / `edit_file` so the wiki index stays
  correct.
- `edit_file` requires the find-string to be unique. Include enough context
  (a surrounding line or two) to disambiguate.

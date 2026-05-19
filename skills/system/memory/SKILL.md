---
name: memory
description: How to use your wiki, conversation history, and document store. Call list_skills/load_skill on this skill when you want the full recall heuristics.
---

# Memory

Your three sources of past context, and when to reach for each.

## Wiki

Your own notes, in markdown, stored under `wiki/` on SharePoint. Reach for it
when the user asks about something you've worked on before, or when a topic
might have an existing page. The wiki tools are Core Tools (available
without loading this skill):

- `wiki_read(path)` — read one page
- `wiki_search(query, { prefix?, limit?, offset? })` — full-text search
- `wiki_write` / `wiki_append` / `wiki_edit` — update pages (prefer these
  over the generic filesystem tools when writing under `wiki/`)
- `wiki_backlinks(path)` — pages that link to this one

Trust your own past notes, but remember: you wrote them. Past-you can be
wrong. If a fact in the wiki contradicts something authoritative, update
the wiki.

## Conversation history

Past chats across all sessions, queryable via `search_history` (coming in
M4). For now, current-session history is automatic.

## Documents

Stakeholder-authored files under `projects/` — PDFs, scope documents, CAD
models. Read these through the `system/documents` skill (M6+); for now,
use `read_file` for any markdown files in `projects/`.

## Recall heuristics

- **Before answering a question about prior work:** call `wiki_search` first
  with the topic name. If hits exist, `wiki_read` the most relevant one.
- **When you learn a stable fact** (decisions, people, project goals,
  conventions): write or update a wiki page so future-you sees it.
- **Drafts and one-offs** go in `drafts/`, not the wiki. The wiki is for
  things worth remembering.
- **Cite your sources** when you surface a fact — say which wiki page or
  document it came from. The user can verify and correct.

## When NOT to recall

- Trivial small-talk
- Strictly procedural tool sequences (`run the build, fix the error`)
- Questions that are clearly grounded in the current message

---
name: memory
description: How to use your wiki, conversation history, and passive-recall block. Call load_skill on this skill when you want the full recall heuristics.
---

# Memory

Your three sources of past context, in priority order: the passive-recall
block (if present this turn), the wiki, and conversation history. Plus
`/distill` — the path to write things back to the wiki.

## Passive recall (auto-injected)

Before you read each user message, the orchestrator may have already
probed your wiki + cross-session history for things related to it and
prepended a `## Possibly relevant context` system block to your prompt.

When that block is present:

- **Use it as your first source.** It's already filtered to the most
  relevant hits.
- If a fact in the block answers the user's question, cite the source
  (`[wiki:agentone/architecture]` or the session title) and quote
  selectively. You don't need to call `wiki_search` again.
- If the block is partial — e.g. it surfaced a page name but no body —
  call `wiki_read` on the cited path to get the full text.
- If the block missed the topic entirely, search yourself (next section).

When that block is NOT present, the user's profile may have passive
recall disabled, or no sources matched. Search yourself.

## Wiki

Your own notes, in markdown, under `wiki/` on SharePoint. Reach for it
when the user asks about something you've worked on before, or when a
topic might have an existing page. Core Tools (always available):

- `wiki_read(path)` — read one page
- `wiki_search(query, { prefix?, limit?, offset? })` — full-text search.
  **Phrase-mode by default** — the engine wraps your query in quotes.
  Send short noun phrases ("project alpha"), not full sentences.
- `wiki_write` / `wiki_append` / `wiki_edit` — update pages (prefer
  these over the generic filesystem tools when writing under `wiki/`)
- `wiki_backlinks(path)` — pages that link to this one

Trust your own past notes, but remember: you wrote them. Past-you can be
wrong. If a fact in the wiki contradicts something authoritative, update
the wiki.

### Draft pages (`wiki/drafts/`)

The `/distill` command writes auto-extracted notes to
`drafts/distilled-<session>-<date>.md`. These are unreviewed — read them
the same way you'd read raw notes:

- Useful as hints; not authoritative.
- Don't cite drafts as if they're canonical. Phrase as "a draft note
  from session X says…".
- If the user asks you to promote a draft entry to a canonical page,
  use `wiki_write` to copy the entry into its proper location.

## Conversation history

Past chats across all sessions, queryable via `search_history`. Use it
when the user refers to something said before and the passive-recall
block missed it.

- `search_history({ query, exclude_session_id?, session_id?, roles?, limit?, offset? })`
  — hybrid FTS5 + vector. Bare tokens are AND-ed; use `OR` between
  variants; wrap multi-word phrases in `"..."`; suffix `*` for prefix.
- Pass `exclude_session_id` set to the current session id when you want
  to recall *prior* memories without re-hitting your own ongoing chat.
- The wiki is the long-term store. If you find something worth keeping
  in `search_history`, distill it into a wiki page so it stops needing
  full-history scans.

### Query strategy — important

FTS5 is literal. If the user said "favourite colour" and you search for
"favorite color", you get zero hits.

- Start with **just the unusual nouns** the user is likely to have used.
  `colour` alone is far better than `favorite colour color`.
- For common variants use `OR` between forms:
  `favourite OR favorite`, `colour OR color`, `behaviour OR behavior`.
- If your first query returns zero hits, **try a broader single-token
  query before giving up.** Don't tell the user "I have no memory of
  that" without retrying.

## Documents

Stakeholder-authored files under `projects/` — PDFs, scope documents,
CAD models. Read these through the `system/documents` skill; for
markdown files in `projects/`, the generic `read_file` is fine.

## Recall heuristics

- **First, check the passive-recall block** (the `## Possibly relevant
  context` system message). It's been pre-filtered for relevance.
- **If the block is empty or missed the topic**, call `wiki_search`
  with a terse noun phrase (the engine phrase-quotes; full sentences
  don't match).
- **If `wiki_search` returns nothing**, broaden to `search_history` with
  the unusual nouns.
- **When you learn a stable fact** worth keeping across sessions
  (decisions, people, conventions): either write a wiki page yourself
  with `wiki_write`, or tell the user "run /distill at the end and I'll
  review the draft." Don't try to remember it in prose — the next
  session won't have your context.
- **Cite your sources** when you surface a fact — say which wiki page,
  session, or draft it came from. The user can verify and correct.

## When NOT to recall

- Trivial small-talk
- Strictly procedural tool sequences (`run the build, fix the error`)
- Questions that are clearly grounded in the current message and need
  no historical context

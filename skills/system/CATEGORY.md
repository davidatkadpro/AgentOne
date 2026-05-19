---
name: system
description: Foundational capabilities — filesystem, shell, web, and recall heuristics that most agents need.
---

# System

Skills in this category provide the building-block capabilities the agent uses
to operate: read and write files, run shell commands, fetch URLs, and reason
about its own memory. The base agent profile loads all `system/*` skills by
default. A sandboxed agent profile can opt out by omitting them from its
`default_skills` list.

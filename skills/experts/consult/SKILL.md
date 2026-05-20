---
name: consult
description: Ask a stronger remote model (OpenRouter expert) a single question. Use sparingly — each call costs real money and is capped by the agent profile's budget. Pass the full context the expert needs; it has no memory of this session.
tools:
  - id: consult_expert
    handler: ./tools/consult.ts
    description: Send a single question + context to an expert Model Profile (role=expert). Returns the expert's reply, the USD cost, and the session's running total spent.
---

# Consult Expert

When the local model can't solve a problem on its own, use `consult_expert`
to ask a stronger remote model. Each call is a one-shot — the expert has no
session memory and won't see the conversation history unless you include it
in `context`.

## When to consult

- The task needs reasoning the local model has demonstrably failed at
  (multiple wrong tool calls, contradictions, "I don't know" loops).
- A user has explicitly asked for a "second opinion" or named the stronger
  model.
- Code review or architectural advice where the local model's output reads
  as plausible-but-shallow.

Do **not** consult for trivia, simple lookups, or anything the local model
should handle. Each call costs money, and the budget is finite.

## Required arguments

- `expert` — the Model Profile id of the expert (e.g. `openrouter-claude-sonnet`).
  Must be in the agent profile's `permissions.experts.allow` list.
- `question` — the specific question to answer. Be sharp; experts don't get
  follow-ups.
- `context` — the relevant background. The expert sees only what you pass
  here. Include the user's actual ask, the failing code, the relevant
  history snippets — whatever it needs to decide.

## Optional arguments

- `system` — a short framing message ("you are a senior reviewer ...").
- `max_tokens` — response cap; defaults to 2048.

## Budget behaviour

- **Per-session budget** (`budget_per_session_usd`) is a hard pre-call gate:
  if the session's running spend already meets or exceeds it, the call is
  refused before it goes out.
- **Per-call budget** (`budget_per_call_usd`) is a post-hoc check: the cost
  is reported back; if it exceeded the per-call cap, an event is emitted but
  the response is still returned (the money is spent).
- Spend is tracked in-memory per session and resets on server restart.

## Tips

- Always include the user's ask verbatim in `context`. Paraphrasing it for
  the expert is a common source of subtly wrong answers.
- Quote relevant code or snippets directly. Don't summarise.
- If you've already attempted the problem, include your attempt and where
  it failed. The expert is more useful as a second pass than a first one.

---
name: experts
description: Consult stronger remote models (OpenRouter, etc.) for hard problems. Gated by the agent profile's permissions.experts allow-list and budget.
---

# Experts

Skills in this category let the agent reach for a more capable remote model
when the local model is stuck. Each call costs real money; the agent profile
controls which expert models are reachable (`permissions.experts.allow`) and
how much can be spent (`budget_per_call_usd`, `budget_per_session_usd`).

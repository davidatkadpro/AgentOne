---
name: proposals
description: Estimates, proposals, and rendering. One module because the three concepts share one user-facing artifact (the proposal) and have no consumers in between.
version: 0.1.0
depends_on:
  - projects
events:
  - estimate.created
  - estimate.updated
  - estimate.accepted
  - estimate.rejected
  - proposal.created
  - proposal.issued
  - proposal.superseded
---

# Proposals

Estimate + proposal records and markdown rendering. Three pricing kinds
(`fixed | time_and_materials | unit`) all expressed in the same
line-item shape; `kind` is a rendering hint, not a schema branch.

Scope is **not** a row here — it lives at `projects/<n>/in/<date>/scope.md`
(written by the `scope-extractor` Email skill). Estimates carry a
`source_scope_path` pointer when generated from one.

See [v2-business-flow.md](../../docs/planning/v2-business-flow.md#modulesproposals)
and [[adr-0004-modules-as-second-extensibility-primitive]].

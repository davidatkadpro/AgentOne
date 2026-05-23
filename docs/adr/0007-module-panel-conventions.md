# Module panel conventions: dynamic actions, inline agent feedback, scoped views

V2 module panels (Projects, Email, Proposals, Invoicing — and any future Module under `modules/<name>/`) inherit a small set of cross-cutting frontend conventions beyond the uniform master/detail shell pinned in [ADR-0006](./0006-frontend-shell-architecture.md). Each Module exposes its actions via **`GET /api/<module>/actions`** which scans `modules/<name>/skills/*/SKILL.md` and returns a typed list the frontend renders as buttons or menu items — drop a Skill folder, get a UI surface, no frontend change. When an action spawns a session, the originating page renders the spawned session's stream **inline** (collapsible block, same renderer as the Chat route) so the operator sees the agent's reasoning where they triggered it; `request_user_input` calls still surface in the notification tray per ADR-0006. Each detail-page tab exposes a **per-tab `Ask agent ▾` menu** populated by tab-tagged Skills, giving discoverable context-aware agent entry points without per-row clutter. Module list pages may render a **KPI strip of clickable filter pills** at the top — counts that double as filters. Modules whose entities carry a `project_id` reuse their list panel inside the project detail's `<module>` tab as a project-filtered view (no new component, just a filter prop). Where an entity has a state machine, the detail toolbar exposes a **status-driven contextual primary button** whose label and action reflect the current status (`Mark ready` → `Issue` → `Mark accepted`), with secondary actions in an overflow menu. Together these conventions make new modules drop-in additions: declare a Skill folder, an entity with `project_id`, and a status enum, and the operator gets a working panel without bespoke UI work.

## Considered alternatives

- **Per-module bespoke patterns.** Let each module designer pick their own action surface, agent integration approach, and detail-page conventions. Rejected — the four module specs we grilled in 2026-05-23 kept converging on the same shapes anyway, and inconsistency across modules is a cognitive tax the operator pays daily. The uniformity is the feature.
- **Skills-only, no UI action buttons.** Drop the per-module action toolbars; rely on the operator typing `/<command>` in chat for every action. Rejected — discoverability is poor (operator has to remember the command vocabulary), and it forces a chat round-trip for actions that should be one-click from the artifact they're acting on (filing an email, pushing an invoice).
- **Hardcoded action lists in the frontend.** Each module's frontend ships a fixed list of action buttons matching its Skills. Rejected — breaks the "drop a folder, get an action" ergonomic that [ADR-0001](./0001-skill-system-as-primary-extensibility.md) and [ADR-0004](./0004-modules-as-second-extensibility-primitive.md) committed to. New Skills would require frontend changes to surface.
- **Inline session stream as an opt-in per module.** Let each module decide whether to render the spawned-session stream inline or push everything to the chat route. Rejected — inconsistent UX across modules (in Email it streams inline; in Proposals you have to go to chat?), and the inline pattern was independently the right call for every module during grilling. Make it the default.
- **Per-row `Ask agent` buttons instead of per-tab menus.** Add a small `🤖` button to every row in every list. Rejected — too noisy; most agent actions are tab- or artifact-scoped, not row-scoped, and per-row buttons would still need a menu to disambiguate which skill to invoke.
- **Generic `/api/actions?module=<name>` endpoint** instead of one per module. Rejected — module-namespaced endpoints (`/api/email/actions`, `/api/invoicing/actions`) compose better with the module-namespaced action-dispatch routes already in v2-business-flow (`POST /api/email/actions`, `POST /api/invoicing/invoices/:id/push`). Symmetry beats a marginal savings of one route.

## Consequences

### Shared frontend components

The conventions assume a small set of shared React components that every module panel reuses (under `src/frontend/components/module/` or wherever the React workspace puts them):

- `<ActionToolbar module contextId actions />` — renders the list returned by `GET /api/<module>/actions` as a row of named primary buttons + `▾ More` overflow. Handles `requires_confirmation: true` by interposing a shadcn `AlertDialog`. Click handler POSTs to the module's action-dispatch endpoint.
- `<InlineSessionStream sessionId open />` — collapsible block that subscribes to the WS session events and renders assistant deltas + tool chips with the same renderer used in the Chat route. Shows a banner that links to the notification tray when `session.awaiting_input` fires. `Open in full chat` escape link.
- `<AskAgentMenu module tab contextId skills />` — dropdown of context-tagged Skills derived from frontmatter. Same dispatch semantics as `<ActionToolbar>`.
- `<KpiStrip pills />` — top-of-list count strip; each pill is a `<button>` that applies a list filter.
- `<StatusActionButton status transitions />` — contextual primary button whose label/action map comes from a per-module status-transition table; overflow menu carries the secondary actions for the current status.

These components are pure renderers; data flow stays in TanStack Query (REST) + Zustand (WS events) per ADR-0006's platform stack pick.

### SKILL.md frontmatter additions

To support `GET /api/<module>/actions` and `<AskAgentMenu>`, the Skill frontmatter schema in [ADR-0001](./0001-skill-system-as-primary-extensibility.md) gains optional fields used by module-scoped Skills:

- `label?: string` — short button label (defaults to a title-cased `name`).
- `icon?: string` — lucide icon name for the button.
- `default_profile?: string` — agent profile to spawn the action's session under.
- `prompt_template?: string` — Mustache-templated seed for `spawnSession`.
- `requires_confirmation?: boolean` — UI shows an AlertDialog before dispatch.
- `surface?: 'action' | 'ask_agent' | 'both'` — controls whether the Skill appears in the action toolbar, the per-tab Ask-agent menu, or both. Default `'ask_agent'` for module-scoped Skills.
- `tabs?: string[]` — for `'ask_agent'` surface, which detail-page tabs this Skill applies to (e.g. `['tasks', 'scope']` on a Projects-scoped Skill).

Frontmatter validation is server-side; broken Skills surface in `GET /api/<module>/actions` with `ok: false` and an error, matching the existing pattern at `GET /api/profiles`.

### Server-side convention

Each Module's HTTP routes follow a fixed namespace shape:

- `GET /api/<module>/<entity>` — list (TanStack Query cache key).
- `GET /api/<module>/<entity>/:id` — detail.
- `POST /api/<module>/<entity>` — create.
- `PATCH /api/<module>/<entity>/:id` — update.
- `DELETE /api/<module>/<entity>/:id` — delete (subject to module-specific guards).
- `GET /api/<module>/actions` — action discovery (the new convention).
- `POST /api/<module>/actions` — action dispatch (existing convention from `modules/email/`).
- Module-specific operational routes live under `/api/<module>/...` namespacing (e.g. `/api/invoicing/invoices/:id/push`).

The Module's `MODULE.md` does not need to declare this surface — the runtime derives it from the Module's service interface and the Skill folder. Modules that don't have `<entity>` collections (e.g. an event-only Module) omit the CRUD routes.

### Project-scoped views are filtered list panels

A module's project-scoped tab inside `/projects/:id` (Emails, Proposals, Invoices) does **not** ship a second UI — it renders the same module-list component with a `projectId` filter prop. KPI strips inside project-scoped views recompute the count pills against the filtered set. This is what makes the project-detail-as-hub pattern from ADR-0006 cheap: each module already has the list panel; the project tab is a thin wrapper.

For this to work cleanly, **every module entity with a project relationship carries an indexed `project_id` column**. The 2026-05-23 grill flagged that the `audit_log` table (from [ADR-0004](./0004-modules-as-second-extensibility-primitive.md)) needs the same indexing for the project-detail **Activity** tab; either an explicit `project_id` column on `audit_log` or a consistent `details_json.project_id` key with a generated-column index. The schema change is out of scope for this ADR but called out as the dependency.

### The agent is reachable on every screen, never modal

The pattern set deliberately avoids any modal-style agent surface — `<InlineSessionStream>` is collapsible inline content; `<AskAgentMenu>` is a dropdown; the notification tray is a right-edge Sheet (manual open) per ADR-0006. This is consistent with the operator's [[non-interrupting-notifications]] preference and the "agent as collaborator, not interrupter" framing. New Modules MUST respect this — no agent surface should auto-open, modal, or steal focus.

### What this does NOT pin

- **Module-specific UX inside a panel** — Projects' detail-as-hub with 8 tabs, Proposals' split view, Invoicing's drift block, Email's compact rows. Those are module-shaped decisions that live in the per-module sections of [`../planning/v2-business-flow.md`](../planning/v2-business-flow.md). The ADR pins the *shared scaffolding*, not the panel shape.
- **Action invocation result rendering inside the spawned session** — that's a Skill author's concern (what the prompt template produces, what tools it calls). The ADR only pins how the result *surfaces* (inline stream + tray).
- **The Skill loader implementation** — covered by [ADR-0001](./0001-skill-system-as-primary-extensibility.md). This ADR layers a *surface* on top.

### Build implications

Phase 1.5 (the React parity rewrite from [ADR-0006](./0006-frontend-shell-architecture.md)) builds the five shared components above as part of the shell — even though only Chat and Settings are populated initially. By Phase 2 (Projects), the components are ready and the Projects panel is the first user of the full convention set. Subsequent module phases (Email, Proposals, Invoicing) consume the components rather than reinventing them; the per-phase work shrinks to module-specific bits (the master/detail content, the entity-shaped forms, the module-specific operational routes).

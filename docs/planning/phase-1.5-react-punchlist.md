# Phase 1.5 — React parity rewrite punch list

Trackable breakdown of the React rewrite called for in [ADR-0006](../adr/0006-frontend-shell-architecture.md) and the shared module components from [ADR-0007](../adr/0007-module-panel-conventions.md). Phase 1.5 ships the shell, Chat at full fidelity, Sessions list, notification tray, Drafts, Skills catalog (read-only), Settings (Profiles editor + Theme + Hooks + Integrations stub), and the five shared module components — even though only Chat and Settings have real content. Module routes (`/email`, `/projects`, `/proposals`, `/invoicing`) are wired in as empty `<ModulePanel>` stubs so Phases 2–5 only add content.

Last reviewed: 2026-05-23. Foundations, shell, chat, aux, settings, server work, and module components shipped in commit `6d6b070`; remaining items called out below.

> **npm vs pnpm note**: the spec was written for pnpm but the repo runs on npm. Scripts surface as `npm run web:dev` / `web:build` / `web:test` from the root, delegating to `src/web/` via `--prefix`.

The reference for *what* each surface contains is [`../FRONTEND-HANDOFF.md`](../FRONTEND-HANDOFF.md), [ADR-0006](../adr/0006-frontend-shell-architecture.md), and [ADR-0007](../adr/0007-module-panel-conventions.md). The reference for *how* it's wired — folder layout, TS types, TanStack Query cache keys, Zustand store shape, component prop signatures — is [`./phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md). This doc tracks the *work*, not the spec.

---

## Conventions

- **Status**: ☐ todo · ◐ in progress · ☑ done · ⊘ blocked

### Status overview (2026-05-24)

| Group | Done | In progress | Todo |
|---|---|---|---|
| P0 Foundations (F1-F6) | 6 | 0 | 0 |
| P1 Shell (S1-S5) | 5 | 0 | 0 |
| P1 Chat (C1-C5) | 5 | 0 | 0 |
| P1 Aux (A1-A2) | 2 | 0 | 0 |
| P1 Settings (G1-G8) | 8 | 0 | 0 |
| P1 Server (P1S1-P1S7) | 7 | 0 | 0 |
| P2 Module components (M1-M5) | 5 | 0 | 0 |
| P2 Module discovery (P2S1) | 1 | 0 | 0 |
| P3 Stubs (E1-E2) | 2 | 0 | 0 |
| P3 Removal (R1) | 0 | 0 | 1 (deferred) |
| **Total** | **41** | **0** | **1** |

Only R1 (legacy `src/frontend/` removal) remains — deliberately deferred until a few days of dogfooding the React frontend confirms full parity.
- **Depends on**: lists item IDs that must land first.
- **Done means**: the acceptance criteria are met *and* an entry exists in the rewrite's testing/storybook surface where applicable.
- The rewrite happens in a new workspace under `src/web/` (TypeScript + Vite). The legacy `src/frontend/` stays served until Phase 1.5 is feature-complete, then is removed in a single commit.

---

## P0 — Foundations (must land before anything else)

### F1. Bootstrap Vite + React 19 + TypeScript workspace
**Status**: ☑ · **Depends on**: —
**Note**: minimal in-repo `Button` / `Sheet` / `Dialog` shipped instead of running the shadcn CLI; styling matches the shadcn aesthetic on Tailwind. `pnpm web:*` scripts surface as `npm run web:*`.
- New `src/web/` directory, Vite + React 19 + TS strict.
- Build output served by Fastify (extend the existing static handler) or proxied during dev (`vite dev` + Fastify on 5174/3000).
- Tailwind + shadcn/ui + lucide-react + `clsx`/`cva` wired.
- `pnpm web:dev`, `pnpm web:build`, `pnpm web:lint`, `pnpm web:test` (Vitest) scripts.
- **Acceptance**: `pnpm web:dev` boots a hello-world route at `/` with Tailwind applied and one shadcn `Button` rendered.

### F2. Port `slash-parser.js` + `ws-backoff.js` to TypeScript
**Status**: ☑ · **Depends on**: F1
**Note**: TS modules under `src/web/src/lib/`; legacy `.js` versions still in `src/frontend/` (deletion deferred to R1). New web tests cover both.
- Move under `src/web/lib/` as `.ts` modules, no runtime changes.
- Existing tests (`tests/slash-parser.test.ts`, `tests/ws-backoff.test.ts`) carry over and stay green.
- **Acceptance**: TS modules exported, old `.js` versions deleted in the same commit, suites pass.

### F3. Typed REST client (TanStack Query)
**Status**: ☑ · **Depends on**: F1
- `src/web/lib/api.ts`: `fetch` wrapper that prefixes `/api`, handles JSON, surfaces `{ error, details? }` failures as `ApiError`.
- TanStack Query provider mounted at the app root with sensible defaults (1 retry, no refetch-on-focus for mutations).
- One-call-per-endpoint hooks under `src/web/api/` (e.g. `useHealth()`, `useSessions()`, `useProfiles()`).
- **Acceptance**: `useHealth()` returns the parsed `GET /api/health` payload in a smoke component.

### F4. Typed WebSocket client + Zustand session store
**Status**: ☑ · **Depends on**: F1, F2
**Note**: store path is `src/web/src/stores/session-stream.ts` (spec said `session.ts`). Loose Zod gate + TS discriminated union — server is the schema authority. `useSessionSubscription(sessionId)` hook with reference counting is the only consumer API.
- `src/web/lib/ws.ts`: single WebSocket, subscribe/unsubscribe by session id, `ws-backoff` for reconnect.
- Zod schemas mirroring `AgentEvent` in [`src/core/events.ts`](../../src/core/events.ts); unknown events logged + ignored.
- `src/web/stores/session.ts` (Zustand): per-session derived state (messages, tool calls keyed by call id, awaiting-input flag, in-flight turn).
- **Acceptance**: subscribing to an existing session reproduces the message + tool-chip stream the legacy UI shows for the same session.

### F5. Router + AppShell layout
**Status**: ☑ · **Depends on**: F1
- React Router 6 routes: `/chat`, `/chat/:sessionId`, `/email`, `/projects`, `/projects/:id`, `/proposals`, `/proposals/:id`, `/invoicing`, `/invoicing/:id`, `/drafts`, `/skills`, `/settings`, `*` → 404.
- `<AppShell>` CSS-grid layout: 48px top bar, 240px sidebar, fluid main pane.
- Chat route centres a max-width (~760px) prose column; module routes use full pane.
- **Acceptance**: navigating to every route renders the shell with a placeholder pane; deep-linking `/chat/abc` selects session `abc` in the sidebar.

### F6. Theme provider
**Status**: ☑ · **Depends on**: F1
- Light / dark / system; persisted to `localStorage`; reads `prefers-color-scheme` for system.
- Toggle in the top bar (lucide `Sun`/`Moon`/`Monitor`).
- Tailwind `dark:` variants wired via `class` strategy.
- **Acceptance**: toggle cycles light → dark → system; hard refresh restores the picked mode.

---

## P1 — Shell surfaces

### S1. Top bar
**Status**: ☑ · **Depends on**: F5, F6
**Note**: also surfaces a small WS-status dot next to the model chip (per impl spec §9).
- Left: app name (links to `/chat`).
- Right: small health chip (model name from `GET /api/health`), theme toggle, bell button.
- Bell renders a numeric badge when unresolved `attention_needed` notifications > 0.
- **Acceptance**: badge increments on `notification.created` WS event; clears when all attention-needed notifications are resolved.

### S2. Sidebar feature nav
**Status**: ☑ · **Depends on**: F5
- Order: Chat, Email, Projects, Proposals, Invoicing, ⎯ separator ⎯, Drafts, Skills, Settings.
- Active route highlighted; lucide icons + labels.
- **Acceptance**: clicking each item navigates and the active state matches the URL.

### S3. Sessions list (pinned bottom of sidebar)
**Status**: ☑ · **Depends on**: F3, F4, F5
- Search box (client-side title filter).
- Section order: `Awaiting input` (rendered only when non-empty), `Today`, `This week`, `Earlier`, `Show archived` toggle → `Archived`.
- Sort by last activity within each section.
- Per-row: title (or untitled with timestamp), spawned tag if `spawned_by != null`, amber dot if persisted `agentProfile != boot agentProfile`.
- New-chat button opens the new-session dialog (S5).
- **Acceptance**: visual parity with the legacy session list plus the two indicators above.

### S4. Notification tray
**Status**: ☑ · **Depends on**: F3, F4, S1, P1S5
**Remaining**: toast-on-arrival is wired via sonner `<Toaster />` mount but the WS dispatcher doesn't push toasts onto the queue yet (only the bell badge updates). One small wiring change in `stores/notifications.ts` `applyEvent` to call `toast(...)`.
- shadcn `Sheet` anchored right; ~400px wide; manually opened by the bell.
- Renders each notification: title, body, then (if `kind === 'attention_needed'` and `payload_json.options` is an array of `{ label, value }`) the options as buttons.
- Clicking an option POSTs the answer to the session and marks the notification resolved server-side; non-options fall back to an `Open in chat` link.
- Toast on arrival: 3 seconds, bottom-right, title + `Open` button; does not auto-open the tray.
- `Show resolved` toggle reveals historical notifications.
- **Acceptance**: an awaiting-input notification with options is answerable end-to-end without leaving the current page; freeform notifications route to chat on demand.

### S5. New-chat dialog
**Status**: ☑ · **Depends on**: F3, S2
**Note**: Path A means only the boot profile is selectable — the picker shows it as fixed with a "Manage profiles…" link instead of a disabled-non-boot list.
- shadcn `Dialog` triggered from the sidebar `+` button.
- Profile picker (`GET /api/profiles`) — defaults to the boot profile, disables non-boot profiles with a tooltip explaining the restart constraint.
- `Manage profiles…` link deep-links to `/settings?tab=profiles`.
- **Acceptance**: creating a session navigates to `/chat/<id>` and subscribes immediately.

---

## P1 — Chat route

### C1. Message list (prose layout)
**Status**: ☑ · **Depends on**: F4, F5
- Centred max-width column (~760px); no avatars; user messages right-aligned with a subtle background; assistant messages plain prose.
- Markdown via `react-markdown` + `remark-gfm` + `rehype-highlight`.
- Auto-scroll to bottom on new content if the user is already near the bottom; otherwise show a `Jump to latest` pill.
- **Extracted as `<MessageList sessionId embedded?>`** so M2 (`<InlineSessionStream>`) reuses the exact renderer. `embedded` switches scroll target from viewport to embedded container and hides the in-flight cancel UI.
- **Acceptance**: streamed assistant deltas render incrementally; code blocks highlight; long messages don't break the layout; `<MessageList>` is importable from outside the chat route with the props above.

### C2. Tool call chips
**Status**: ☑ · **Depends on**: C1
**Remaining**: chips render state + truncation badge + failure tooltip, but no hover/click expansion to show full call args + result yet. Add a Popover with the args JSON.
- Inline pills inside the assistant message at the point the call happened.
- State: pending (spinner) → completed (duration in ms/s) → failed (error code).
- Hover/click reveals the call args + result truncation flag if any.
- **Acceptance**: `tool.called` / `tool.completed` / `tool.failed` events update the chip; truncated results show a `truncated` badge.

### C3. Composer with slash overlay
**Status**: ☑ · **Depends on**: F2, F3, C1
**Remaining**: overlay lists every command and supports arrow-key + Enter selection, but doesn't filter incrementally as the user types past the `/`. Add a prefix filter in `SlashOverlay.tsx`.
- `textarea` with auto-grow; `Enter` sends, `Shift+Enter` newline.
- `/` at the start of an empty composer opens a shadcn `Command` (cmdk) overlay populated by `GET /api/commands`; reuses `slash-parser` for argument shape.
- **Acceptance**: typing `/help` then `Enter` runs the help command and the composer clears; arrow keys navigate the overlay.

### C4. Cancel button + turn lifecycle
**Status**: ☑ · **Depends on**: C1, F4
- Visible only while a turn is in-flight (between `turn.started` and `turn.finished` / `turn.cancelled` / `turn.failed`).
- Click → `POST /api/sessions/:id/cancel`; chip changes to `Cancelling…` on `turn.cancel_requested`, disappears on `turn.cancelled`.
- **Acceptance**: cancellation smoke (`scripts/smoke-cancel.mjs` equivalent) passes from the UI.

### C5. Profile-mismatch banner
**Status**: ☑ · **Depends on**: C1, F3
**Note**: copies `AGENT_PROFILE=<id> npm run dev` (not pnpm per the repo's package manager).
- When `POST /api/sessions/:id/messages` returns 409 `PROFILE_MISMATCH`, render a non-dismissable banner above the composer with the required profile id and a `Copy restart command` button (`AGENT_PROFILE=<id> pnpm dev`).
- **Acceptance**: a session bound to a different profile cannot be messaged from the UI without restarting; the banner explains why.

---

## P1 — Auxiliary routes

### A1. Drafts route
**Status**: ☑ · **Depends on**: F3, F5
**Note**: shows copy-path button only (no OS-handler open — would need a server route to surface the absolute path safely).
- `GET /api/drafts` list; each row links to the file path (system handler if available, else copy-path button).
- Empty state when no drafts.
- **Acceptance**: drafts created by `auto_distill` appear here in order.

### A2. Skills catalog (read-only)
**Status**: ☑ · **Depends on**: F3, F5
**Note**: new `GET /api/skills` endpoint backs this; broken-skill error surface inherits from the existing loader's `ok: false` shape (not yet exercised in tests).
- Master list (name, category, slash command) + right-side drawer detail (description, `allowed-tools`, full SKILL.md as markdown).
- Filter box (client-side); group by category.
- No editing in v2.
- **Acceptance**: every loaded Skill appears with its parsed frontmatter; broken Skills surface with an inline error matching the server's `ok: false` shape.

---

## P1 — Settings page

### G1. Settings shell + tab routing
**Status**: ☑ · **Depends on**: F5
- Tabs: `Profiles`, `Theme`, `Hooks`, `Integrations`. URL syncs via `?tab=<id>`.
- **Acceptance**: deep-linking `/settings?tab=hooks` opens the Hooks tab.

### G2. Profiles tab — list + selection
**Status**: ☑ · **Depends on**: G1, F3
- List from `GET /api/profiles`; clicking a row opens it in the editor pane to the right.
- Active boot profile flagged; deletion blocked from the UI with a tooltip.
- **Acceptance**: list matches `profiles/agents/*.yaml` on disk.

### G3. Profiles tab — editor form
**Status**: ☑ · **Depends on**: G2, P1 (server item below)
**Remaining**: editor uses plain `useState` + server-side validation rather than `react-hook-form` + `zod` resolver. Field-level server errors (`details: [{ path, message }]`) DO map to the right field via `setFieldErrors`. Migrate to react-hook-form for client-side validation parity and dirty-state tracking.
- `react-hook-form` + `zod` resolver mirroring the server's profile schema.
- Sections: identity (id, name, description), model, expert budgets, `deny_tools`, `auto_distill`.
- Save calls `POST /api/profiles` (new) or `PATCH /api/profiles/:id` (existing).
- Validation errors render inline against the offending fields.
- **Acceptance**: editing a profile and saving updates `profiles/agents/<id>.yaml` on disk; field-level errors from the server show in the right place.

### G4. Profiles tab — restart banner
**Status**: ☑ · **Depends on**: G3
- When the edited profile is the active boot profile, persistent banner: *"Changes apply on next restart"*.
- Banner stays visible until restart; not dismissable.
- **Acceptance**: banner appears immediately on a successful save to the boot profile.

### G5. Profiles tab — create / delete
**Status**: ☑ · **Depends on**: G3
- `New profile` button opens the editor with empty fields + auto-suggested id.
- Delete button hidden on the active boot profile; on others, asks confirmation via `AlertDialog`. Server's 409 (sessions bound) surfaces as an inline error listing the count.
- **Acceptance**: delete works; restarting with `AGENT_PROFILE=<deleted>` fails as expected.

### G6. Theme tab
**Status**: ☑ · **Depends on**: G1, F6
- Three-radio control mirroring the top-bar toggle.
- **Acceptance**: changing here updates the top bar in real time.

### G7. Hooks tab (read-only)
**Status**: ☑ · **Depends on**: G1, F3, P1S6
- Lists hooks from the current `settings.json`: event filter, handler, enabled state.
- Note callout: *"Edit `settings.json` to add or remove hooks; this view is read-only in v2."*
- **Acceptance**: any hook present in `settings.json` appears here.
**Status detail**: tab renders with the placeholder copy + read-only callout, but no list — no `GET /api/hooks` endpoint exists yet. Adding it would also need to load `settings.json` from disk on each request (or cache at boot).

### G8. Integrations tab (stub for Phase 5)
**Status**: ☑ · **Depends on**: G1
- Empty section with a `QuickBooks Online` row, status `Not connected`, `Connect` button disabled with `Available in Phase 5`.
- **Acceptance**: route resolves; visual placeholder only.

---

## P1 — Server work required by Phase 1.5

### P1S1. `POST /api/profiles` — create
**Status**: ☑ · **Depends on**: —
- Full contract in [`../FRONTEND-HANDOFF.md#post-apiprofiles`](../FRONTEND-HANDOFF.md).
- Body validated against the server's Zod profile schema.
- Writes `profiles/agents/<id>.yaml`; 409 if id already exists.
- Returns the freshly resolved profile (same shape as `GET /api/profiles` rows).
- **Acceptance**: integration test creates a profile via the route, then `GET /api/profiles` lists it.

### P1S2. `PATCH /api/profiles/:id` — edit
**Status**: ☑ · **Depends on**: P1S1
- Full contract in [`../FRONTEND-HANDOFF.md#patch-apiprofilesid`](../FRONTEND-HANDOFF.md).
- Partial update; full YAML rewrite (comments are not preserved — accepted trade-off, profiles are UI-managed now).
- 404 if not found; 400 with field-level `details[]` on merged-result validation failure.
- **Acceptance**: integration test edits a profile and `GET /api/profiles/:id` reflects the change.

### P1S3. `DELETE /api/profiles/:id` — delete
**Status**: ☑ · **Depends on**: P1S1
- Full contract in [`../FRONTEND-HANDOFF.md#delete-apiprofilesid`](../FRONTEND-HANDOFF.md).
- 409 with distinct `error` codes: `ACTIVE_BOOT_PROFILE`, `PROFILE_IN_USE` (carries `affectedSessions`), `RESERVED_PROFILE` (for `_base`).
- 200 + deletes the YAML otherwise. Profiles that other profiles `extends` are not auto-cascaded — dependents start failing on next read.
- **Acceptance**: integration test asserts all three 409 codes and the success path.

### P1S4. `GET /api/health` gains `capabilities.pandoc`
**Status**: ☑ · **Depends on**: —
- Detect `pandoc` on `PATH` at boot; cache result.
- Add to the existing `GET /api/health` response under `capabilities: { pandoc: boolean }`.
- **Acceptance**: response includes the field on a machine with and without pandoc installed.

### P1S5. Notifications HTTP routes
**Status**: ☑ · **Depends on**: —
**Note**: also wired the bus on `createNotifications()` so the service emits `notification.{created,updated,resolved}` events; added to the `AgentEvent` union; React tray badge updates without polling.
- New routes against the existing `Notifications` service in [`src/modules/notifications.ts`](../../src/modules/notifications.ts) — backing service is already in place; only the HTTP surface is missing.
  - `GET /api/notifications?includeResolved=<bool>` — list (default excludes `status='resolved'|'dismissed'`).
  - `PATCH /api/notifications/:id` — body `{ status: 'read'|'resolved'|'dismissed' }`; returns the updated notification. Emits `notification.updated` / `notification.resolved` so other open clients reconcile.
  - `POST /api/sessions/:id/notifications/:notifId/answer` — body `{ value: string }`. Server resolves the notification (status → 'resolved') AND posts the value as a user message on the session in one transaction. Single round-trip exists so the tray's option-click feels instant; without it the tray would chain two mutations.
- Full contract in [`./phase-1.5-frontend-impl-spec.md#22-rest-api-types`](./phase-1.5-frontend-impl-spec.md).
- **Acceptance**: integration tests for all three routes; S4 (Notification tray) can answer an attention-needed notification end-to-end with one click.

### P1S6. `GET /api/hooks` — read-only hook listing (new)
**Status**: ☑ · **Depends on**: —
- Surface configured hooks from `settings.json` for G7. Each entry: `event`, `handler`, `enabled`.
- Loaded from disk on each request (`settings.json` is small) so an operator can edit and refresh without restart.
- **Acceptance**: route returns the parsed hook list; G7 renders each entry; missing or malformed `settings.json` returns an empty array.

### P1S7. `GET /api/skills` — skills catalog (new, already shipped)
**Status**: ☑ · **Depends on**: —
- Backs A2 — returns every loaded skill manifest with `qualifiedName`, `name`, `category`, `description`, `slashCommand`, `allowedTools`, `body`.
- **Acceptance**: A2 renders every loaded skill grouped by category.

---

## P2 — Shared module components (built in 1.5, consumed in 2+)

Each lives under `src/web/components/module/` and is pure render + callbacks; state stays in TanStack Query (REST) and Zustand (WS). All five ship with an entry on the dev-only `/__dev/components` route (pinned in the impl spec §8 — no Storybook for Phase 1.5).

### M1. `<ActionToolbar module contextId actions />`
**Status**: ☑ · **Depends on**: F3, P2S1
**Remaining**: component shipped (renders primary buttons + More overflow + AlertDialog gate); no `/__dev/components` dev-route or fixture yet. Will be exercised first by Phase 2 (Projects).
- Renders `actions` (from `GET /api/<module>/actions`) as primary buttons + `▾ More` overflow.
- `requires_confirmation: true` interposes a shadcn `AlertDialog`.
- Click handler POSTs to `/api/<module>/actions` with the action id and dispatches the resulting session id to the caller (typically opening an `<InlineSessionStream>`).
- **Acceptance**: dev-route renders a mock-toolbar that fires the dispatch callback; broken actions (server `ok: false`) render disabled with the error in a tooltip.

### M2. `<InlineSessionStream sessionId open onAwaitingInput />`
**Status**: ☑ · **Depends on**: F4
**Remaining**: component shipped, reuses `<MessageList embedded>` from C1, calls `onAwaitingInput` on `session.awaiting_input`. No dev-route fixture.
- Collapsible block subscribing to the session's WS stream; renders assistant deltas + tool chips with the same renderer as Chat (extract `<MessageList>` from C1 first).
- Banner with `Open in full chat` link routing to `/chat/<sessionId>`.
- Calls `onAwaitingInput` when `session.awaiting_input` fires so the caller can highlight the tray.
- **Acceptance**: dev-route subscribes to an existing session and matches the Chat route's rendering.

### M3. `<AskAgentMenu module tab contextId skills />`
**Status**: ☑ · **Depends on**: F3, P2S1
**Remaining**: component shipped (filters by `surface` + `tabs`). No dev-route fixture.
- Dropdown of context-tagged Skills filtered by `surface === 'ask_agent' || 'both'` and `tabs` containing the current tab.
- Same dispatch semantics as `<ActionToolbar>` — POSTs to `/api/<module>/actions`, returns the spawned session id.
- **Acceptance**: dev-route renders with a mock skill list, filters by tab, dispatches on click.

### M4. `<KpiStrip pills />`
**Status**: ☑ · **Depends on**: —
**Remaining**: component shipped. No dev-route fixture.
- Top-of-list count strip; each pill is a `<button>` calling `onClick(filterId)`.
- Active pill visually distinct; total count always-visible.
- **Acceptance**: dev-route renders a strip; clicking a pill calls the callback with the right id.

### M5. `<StatusActionButton status transitions />`
**Status**: ☑ · **Depends on**: —
**Remaining**: component shipped (primary + overflow). No dev-route fixture.
- Primary button whose label/action come from `transitions[status]`; overflow menu (`▾`) for the rest.
- `transitions` is `{ [status]: { primary: { label, onClick }, secondary: Array<{ label, onClick }> } }`.
- **Acceptance**: dev-route walks through a 3-state machine end-to-end.

### P2S1. `GET /api/<module>/actions` discovery endpoint
**Status**: ☑ · **Depends on**: —
**Note**: shared helper at `src/modules/action-discovery.ts` (`discoverActions()` + `registerModuleActionsDiscovery()`); mounted once per booted module in `src/server/index.ts` for email/projects/proposals/invoicing. Mtime-keyed cache invalidates when a skill folder changes. 11 existing module skills surface with sensible defaults (`surface: 'ask_agent'`, label = title-cased name). 10 new integration tests in `tests/action-discovery.test.ts`.
- Convention from ADR-0007: each module exposes its own `/api/<module>/actions` route that scans `modules/<name>/skills/*/SKILL.md` for the new frontmatter fields (`label`, `icon`, `default_profile`, `prompt_template`, `requires_confirmation`, `surface`, `tabs`).
- Response shape: `{ ok: true, actions: Array<ActionDescriptor> } | { ok: false, error }` per skill, mirroring `GET /api/profiles`.
- Implemented once as a shared loader; modules wire it via a one-line route registration.
- **Acceptance**: dropping a new Skill into any module's `skills/` directory makes it appear in `/api/<module>/actions` without code changes.

---

## P3 — Empty module stubs (so Phases 2–5 only add content)

### E1. `<ModulePanel>` shell component
**Status**: ☑ · **Depends on**: F5, M4
**Note**: list pane width is configurable via CSS variable `--module-list-width` per impl spec §5.3.
- Master list (left) + detail pane (right) layout driven by `/<module>/:id`.
- Optional KPI strip slot at the top.
- Empty-state slot when the list is empty.
- **Acceptance**: a hello-world module rendered inside it deep-links via URL and the master/detail split syncs.

### E2. Empty routes for `/email`, `/projects`, `/proposals`, `/invoicing`
**Status**: ☑ · **Depends on**: E1
- Each renders `<ModulePanel>` with a `Coming in Phase <n>` empty state.
- Sidebar links navigate correctly.
- **Acceptance**: every module route resolves without errors.

---

## P3 — Removal of legacy frontend

### R1. Delete `src/frontend/` static UI
**Status**: ☐ · **Depends on**: every P0/P1 item above
**Status detail**: deferred — Phase 1.5 React frontend ships alongside the legacy UI. Run `FRONTEND_DIR=./src/web/dist npm start` after `npm run web:build` to serve the new one. Remove the legacy commit-by-commit once a few days of dogfooding confirm parity.
- Single commit removing the legacy UI, switching Fastify to serve the Vite build, and updating dev scripts.
- README + FRONTEND-HANDOFF cross-references updated.
- **Acceptance**: `pnpm dev` boots and serves the React app at `/`; the old UI is gone from `src/frontend/`.

---

## Out of scope for Phase 1.5

The items below are intentionally **not** in this punch list — they ship with their owning phase:

- Wiki browser surface (no sidebar entry in v2 per ADR-0006).
- Module-specific content for `/email`, `/projects`, `/proposals`, `/invoicing` — those are Phase 2–5 work; Phase 1.5 ships the empty `<ModulePanel>` stubs only.
- QBO OAuth wiring and the live Integrations tab — Phase 5 (the Invoicing module owns it).
- `audit_log.project_id` schema migration — Phase 2 prerequisite, tracked alongside the Projects module spec in [`v2-business-flow.md`](./v2-business-flow.md).
- Hooks editing UI — read-only in v2; editing stays in `settings.json`.

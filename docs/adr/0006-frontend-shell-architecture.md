# Frontend shell: chat-as-route with notification-mediated cross-page awareness

The React frontend is structured as a fixed shell — a top bar (theme toggle + notifications bell), a left sidebar (feature links above, session list below), and a single main pane — where **Chat is one route among several, not a persistent dock**. The sidebar lists Chat first, then the v2 module panels (Email, Projects, Proposals, Invoicing), then the auxiliary surfaces (Drafts, Skills, Settings), with the Session list pinned to the bottom. The main pane fills its container for module panels but centres a max-width prose column for Chat. All four module panels share one **uniform master/detail layout** driven by `/<module>/<id>` URLs. Cross-page awareness — the case where an agent in a spawned session calls `request_user_input` while the user is on a different page — is mediated by the **notification tray**: a right-edge Sheet, manually opened via the bell, that renders each `attention_needed` notification's question alongside the `payload_json.options` as inline answer buttons. Clicking an option POSTs the answer to the session; the user never leaves the current page. Freeform (no-options) questions fall back to an "Open in chat" link. This makes the agent a collaborator surfaced *through notifications* rather than an omnipresent dock, and keeps module panels uninterrupted during routine non-LLM work.

## Considered alternatives

- **Persistent chat dock + module panels.** Chat always visible on the left; panels render on the right. Rejected by the operator — preferred the agent be reachable via a sidebar link and a notification badge rather than constantly on-screen. Avoids visual competition between chat and panels and gives module panels the full pane width.
- **Workspace shell (VS Code-like activity bar).** Most powerful IA; most UX surface. Rejected as IDE cosplay for a single-user operations app.
- **Tab-bar / sibling routes only, no session list in sidebar.** Same shell as the chosen design but without the pinned session list. Rejected because the session list is *the* primary navigation aid for chat — pulling it into a separate "Sessions" route adds a click to the most-used path.
- **Auto-route to chat on `session.awaiting_input`.** Strong interrupt; ensures full context. Rejected because it yanks the user out of unrelated flows. The notification-tray inline-answer pattern delivers the same information without breaking focus.
- **Notification tray as Popover anchored to the bell.** Lighter overlay; fine for short queues. Rejected because notifications carrying 3–4 option buttons need vertical room, and outside-click dismissal is dangerous when the user is mid-click on an action button.
- **Module-specific layouts** (Email inbox+preview; Projects card grid; Invoicing dashboard; etc.). Better per-module UX; ~3× design and build work. Rejected at v2 in favour of uniform master/detail; can be revisited per-module if one outgrows the pattern.
- **Profile management as read-only picker + inspector only.** Match the v1 server contract; zero new endpoints; YAML stays the source of truth in git. Rejected — the operator wants a full editor in the UI for create/edit/delete. This is a real scope decision: profile management moves out of git-managed YAML and into the app, and it requires accepting the boot-profile restart constraint as a visible UX element.

## Consequences

### Shell, routes, and layout

- **Route table is fixed**: `/chat` (with active session id in URL or query), `/email`, `/projects`, `/proposals`, `/invoicing`, `/drafts`, `/skills`, `/settings`. Module routes use `/<module>` for the master list and `/<module>/<id>` for the master+detail view.
- **One `<ModulePanel>` shell component** drives Email, Projects, Proposals, Invoicing. It owns the optional KPI strip (e.g. Invoicing budget rollup), the master list, the detail pane, and URL syncing. New modules added later inherit this shell rather than designing new layouts.
- **Chat content column is centred and max-width (~760px)**; module content fills the pane. This split is intentional: chat is prose and wants reading-width; module data is tabular and wants screen-width.
- **The agent is not omnipresent on every page**, but it is one click away (via the Chat link, the bell, or a session row in the sidebar). The "agent as collaborator" framing is delivered through *availability and notification*, not through *constant presence*.

### Sessions list

- **Pinned structure in the sidebar's bottom region**: "Awaiting input" section at top (only rendered when non-empty), then "Today", "This week", "Earlier" recency groups, then a "Show archived" toggle that reveals an "Archived" section. Sort by last activity within each section.
- **Per-row indicators**: spawned sessions (`spawned_by != null`) carry a small "spawned" tag; sessions whose persisted profile mismatches the boot profile carry an amber dot (the M14–M19 `PROFILE_MISMATCH 409` guard surfaces visually here).
- **Search box** above the list (client-side filter by title).

### Notification tray

- **Component**: shadcn `Sheet` anchored to the right edge. Bell click opens it; no auto-open. Width ~400px; the Sheet stays open while the user clicks through option buttons.
- **Per-notification rendering**: title + body + (if `kind === 'attention_needed'` and `payload_json.options` is structured) the options as buttons; otherwise an "Open in chat" link that routes to `/chat/<session_id>`. A "Show resolved" toggle reveals historical notifications.
- **Toast on arrival**: new `attention_needed` notifications emit a 3-second bottom-right toast with title + Open button. Bell badge increments. Nothing else interrupts the user's current page.
- **Server-side contract**: when the orchestrator emits `notification.created` for a `request_user_input` call, the `payload_json` MUST carry `{ question: string, options?: Array<{ label: string, value: string }> }` in that shape. Unknown shapes fall back to freeform display. This is now part of the v2 frontend contract — orchestrator and any Module writing `attention_needed` notifications must conform.

### Chat

- **Message rendering**: prose style, no avatars, assistant messages in a centred max-width column, user messages right-aligned with a subtle background. Markdown via `react-markdown` + `remark-gfm` + `rehype-highlight`.
- **Tool calls**: rendered as small inline pills inside the assistant message at the point they were called (current handoff pattern). State on the pill (pending / completed-with-duration / failed-with-code) updated from `tool.called` / `tool.completed` / `tool.failed` events.
- **Composer**: `textarea` with a shadcn `Command` (cmdk) overlay triggered by `/` at the start of an empty composer; populates by `GET /api/commands`; reuses the existing slash-parser logic.
- **Cancel button** on in-flight turns calls `POST /api/sessions/:id/cancel`; observable via `turn.cancel_requested` and `turn.cancelled` events.

### Skills catalog

- **Read-only list + right-side drawer detail** (master/detail variant of the module pattern). List rows: name, category, slash command. Drawer: description, declared `allowed-tools`, full SKILL.md body rendered as markdown.
- **No editing in v2.** Skills are still authored on disk.

### Settings page

First-cut content (v2):
- **Profiles** tab — full editor (create / edit / delete agent profiles, including expert budgets and `deny_tools` inline with the profile). Active boot profile shows a persistent "Changes apply on next restart" banner; deletion of the active boot profile is blocked. New-chat dialog has a "Manage profiles…" link that deep-links here.
- **Theme** — light / dark / system toggle (mirrors the top-bar toggle for discoverability; persisted to `localStorage`).
- **Hooks** — read-only listing of hooks configured in `settings.json` (event filter + handler). Editing remains in the JSON file in v2.
- **Integrations** (added during the 2026-05-23 Invoicing grill) — connection panels for external services. v2 has one: **QuickBooks Online** with `Connect` / `Disconnect` buttons, OAuth2 PKCE flow handled via `/api/integrations/qbo/connect` and `/api/integrations/qbo/callback`, `Last synced` timestamp, token expiry. Disconnected/expired state surfaces as a banner on `/invoicing` that deep-links here. The Integrations section is the canonical home for any future third-party connector (additional accounting systems, mail providers beyond the existing EmailSource picker, etc.).

Explicitly omitted from the first cut: a separate "Health & storage info" panel. The diagnostic data from `GET /api/health` lives in the top bar (e.g. model name in a small chip) or in the Profiles tab next to the active profile, not as a standalone Settings section.

### Profile editor — server work

The full-editor decision adds **new endpoints** to the v1 contract:
- `POST /api/profiles` — create a profile (body validated against the server's Zod schema; writes `profiles/agents/<id>.yaml`).
- `PATCH /api/profiles/:id` — edit a profile in-place.
- `DELETE /api/profiles/:id` — delete (server refuses if the profile is the active boot profile or if any non-archived session is bound to it; returns a 409 with the affected session count).
- All three return the freshly-resolved profile, the same shape `GET /api/profiles` already returns. Validation errors return 400 with field-level details mappable to `react-hook-form` errors.

The active boot profile retains the v1 restart constraint — server reads YAML on each request but caches the resolved boot profile until restart, so the UI must surface this honestly rather than imply live reload.

### Platform stack

The frontend uses **Vite + React 19 + React Router 6 + TanStack Query (REST) + Zustand (WS-driven session state) + shadcn/ui on Tailwind + lucide-react + react-hook-form + zod + react-markdown (with remark-gfm + rehype-highlight)**. The existing pure-logic helpers in [`src/frontend/slash-parser.js`](../../src/frontend/slash-parser.js) and [`src/frontend/ws-backoff.js`](../../src/frontend/ws-backoff.js) are ported to TypeScript and reused; their tests (`tests/slash-parser.test.ts`, `tests/ws-backoff.test.ts`) carry over.

### Phasing alignment

This ADR describes the *target* shell. Build phasing follows [`../planning/v2-business-flow.md`](../planning/v2-business-flow.md):
- **Phase 1.5** (React parity rewrite): the shell, Chat route at full fidelity, Sessions list with all per-row indicators, notification tray (functional but mostly empty until modules emit notifications), Drafts route, Settings → Profiles editor, Skills catalog read-only.
- **Phases 2–5**: each module phase builds its `/<module>` route inside the shared `<ModulePanel>` shell. No more shell changes after Phase 1.5.

Wiki has no sidebar surface in v2; the agent's memory remains agent-mediated (via `wiki_search`, `wiki_read` tool calls). If a wiki browser is added later it joins the auxiliary group; not committing to it now keeps scope bounded.

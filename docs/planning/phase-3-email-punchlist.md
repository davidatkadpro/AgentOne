# Phase 3 — Email panel punch list

Trackable breakdown of the Email module's React panel + the cross-module wiring it adds to the Projects Emails tab. Domain spec: [`v2-business-flow.md#modulesemail`](./v2-business-flow.md#modulesemail). Impl scaffolding: [`./phase-3-email-impl-spec.md`](./phase-3-email-impl-spec.md).

Assumes Phase 1.5 (shell + shared components + action discovery) and Phase 2 (Projects panel with the Emails tab placeholder) have shipped.

Last reviewed: 2026-05-29.

---

## Conventions

- **Status**: ☐ todo · ◐ in progress · ☑ done · ⊘ blocked
- **Depends on**: lists item IDs that must land first.

---

## Status overview

| Group | Done | In progress | Todo |
|---|---|---|---|
| P0 Backend route gaps (P3P1-P3P8) | 8 | 0 | 0 |
| P1 Inbox list (I1-I4) | 4 | 0 | 0 |
| P2 Detail view (D1-D4) | 4 | 0 | 0 |
| P3 Action toolbar + inline stream (A1-A3) | 3 | 0 | 0 |
| P4 file-to-project end-to-end (F1-F3) | 3 | 0 | 0 |
| P5 create-new-project + scope-extractor (S1-S2) | 2 | 0 | 0 |
| P6 Project Emails tab content (X1) | 1 | 0 | 0 |
| P7 Polish + agent QA (Q1-Q3) | 3 | 0 | 0 |
| Sub-phase: GraphEmailSource (G1-G4) | 4 | 0 | 0 (landed 2026-05-29) |
| **Total** | **31** | **0** | **1** (1 P0 deferred) |

---

## P0 — Backend route gaps (block frontend data flow)

### P3P1. Alias `/api/v1/email/*` → `/api/email/*`
**Status**: ☑ · **Depends on**: —
- Same pattern as Phase 2's P2P1 — mount handlers under the new path; deprecation aliases on `/api/v1/`.
- **Acceptance**: `curl /api/email` returns same shape as `curl /api/v1/email`; existing v1 tests still pass.

### P3P2. `GET /api/email/:id/body` — rendered body
**Status**: ☑ · **Depends on**: P3P1
- Returns `{ emailId, kind, content, attachments }` where `content` is sanitised HTML or plain text and `attachments` is `Array<{ filename, bytes, contentType }>`.
- Reads from the configured `EmailSource` adapter (Maildir for now); 404 if the source no longer has the message; 503 if the source is offline.
- Server-side sanitisation happens inside the adapter (see P3P3) — by the time this route returns, content is safe.
- **Acceptance**: returns text for plain emails, HTML (script-stripped) for HTML emails; attachments list matches the source.

### P3P3. Server-side HTML sanitiser in the EmailSource adapter
**Status**: ☑ · **Depends on**: P3P2
- Use `sanitize-html` (or equivalent) inside `MaildirEmailSource.getBody()` to strip `<script>`, `<iframe>`, `<object>`, `<embed>`, `on*=` attributes, `javascript:` URLs, and inline `style` attributes.
- Allow: standard block + inline tags, `<a href>` with safe protocols, `<img src>` with `https://` only (CID images stay broken).
- **Acceptance**: planted HTML with `<script>alert('x')</script>` returns content with the script removed; tests cover script tags, javascript: URLs, onload handlers, style attrs.

### P3P4. `GET /api/email/:id/attachments/:name`
**Status**: ☑ · **Depends on**: P3P1
- Streams the attachment bytes with `Content-Disposition: attachment; filename="<sanitised>"` and the source-reported `Content-Type`.
- 404 if the source no longer has the email or the named attachment doesn't exist; 503 if the source is offline.
- **Acceptance**: download a PDF attachment from a planted Maildir email; bytes match.

### P3P5. `POST /api/email/actions` accepts ADR-0007 shape
**Status**: ☑ · **Depends on**: P3P1
- Current body: `{ emailId, action, args? }`. Add support for `{ contextId, action, args? }` (ADR-0007 symmetric shape) — accept either key for one release, log a warning on the legacy key.
- **Acceptance**: dispatching with `contextId` works; dispatching with `emailId` still works.

### P3P6. Verify `email.filed` payload carries `projectId`
**Status**: ☑ · **Depends on**: —
- The event already has `projectId` in the union — re-verify it's emitted from the service and that the WS invalidation dispatcher routes it to `projects.detail(projectId)`.
- **Acceptance**: filing an email triggers a refetch of `projects.detail(<projectId>)` (visible by the project's Emails tab showing the new row without a manual refresh).

### P3P7. `MaildirEmailSource` fs-watcher
**Status**: ☑ · **Depends on**: —
- Use `chokidar` (or `node:fs.watch`) on the maildir root. New `.eml` files trigger `service.ingestEmail` automatically and fire `email.received`.
- Cleanly handles partial writes (use `awaitWriteFinish: { stabilityThreshold: 500 }`).
- **Acceptance**: dropping a new `.eml` into the watched folder makes it appear in the React inbox within a second, no manual refresh.

### P3P8. Retire `POST /api/email/:id/file-to-project` in favour of action dispatch
**Status**: ☑
- Route removed from `modules/email/src/routes.ts`; `FileToProjectBody` schema deleted with it.
- Two stale route tests in `tests/email-routes.test.ts` removed — the synchronous service path is still covered by `tests/email-file-to-project.test.ts`, and the HTTP entry point lives in `tests/email-actions.test.ts` (action dispatch via `POST /api/email/actions { action: 'file-to-project' }`).
- No scripts or skills called the orphan endpoint directly.

---

## P1 — Inbox list

### I1. `/email` route + ModulePanel shell
**Status**: ☑ · **Depends on**: P3P1
- Replace the empty `EmailRoute.tsx` stub with `<ModulePanel>` + `<EmailKpiStrip>` + the email list.
- Default filter is unread; URL `?filter=unread|filed|attached` flips it.
- Client-side search box (filter on subject + sender + snippet — no full-body search).
- Empty state when no emails ingested.
- **Acceptance**: list renders rows from `GET /api/email`; filter pills work; URL sync survives refresh.

### I2. EmailListRow design
**Status**: ☑ · **Depends on**: I1
- 2-line compact row:
  - Line 1: sender (bold if unread) + date right-aligned
  - Line 2: subject (bold if unread) + snippet preview
  - Right edge: 📎 if `hasAttachments`, `→ <projectNumber>` chip if `filedProjectId`
- Filed chip clickable: navigates `/projects/<filedProjectId>?tab=emails`
- Row click → navigate to `/email/<id>`
- Hosts `<EmailRowChip>` from the email-chips store
- **Acceptance**: visual parity with the spec mockup; chip navigates correctly; unread bold treatment matches `isRead` flag.

### I3. KPI strip with filter pills
**Status**: ☑ · **Depends on**: I1
- `<EmailKpiStrip>` above the list: Unread / Filed / Has attachments counts, each clickable to flip `?filter=`.
- Active pill visually distinct; "All" pill clears the filter.
- Counts come from filtered `GET /api/email` calls — three small queries cached per filter shape.
- **Acceptance**: clicking each pill applies the filter; counts update on `email.*` WS events.

### I4. Refresh button + WS-driven live updates
**Status**: ☑ · **Depends on**: I1, P3P7
- Manual `<EmailRefreshButton>` in the list header calls `POST /api/email/poll`. Shows a toast: "3 new, 1 skipped".
- WS subscriber invalidates `emails.list()` on every `email.received` so new mail appears without a click.
- **Acceptance**: dropping an `.eml` into the maildir surfaces in the React inbox within 1 second; manual refresh still works as a fallback.

---

## P2 — Detail view

### D1. `/email/:emailId` route + EmailHeader
**Status**: ☑ · **Depends on**: P3P1
- New `EmailDetailRoute.tsx` fetches `GET /api/email/:id`.
- Renders `<EmailHeader>`: subject, sender (mailto: link), to address, date. `Mark unread` button to revert auto-read.
- On mount, calls `PATCH /api/email/:id { isRead: true }` if currently unread.
- **Acceptance**: opening an unread email marks it read; `Mark unread` toggles back; back navigation preserves the inbox filter.

### D2. EmailBody with sanitised HTML rendering
**Status**: ☑ · **Depends on**: D1, P3P2, P3P3
- `useEmailBody(emailId)` fetches `/api/email/:id/body`.
- For `kind: 'text'`, render `<pre className="whitespace-pre-wrap">`.
- For `kind: 'html'`, run client-side DOMPurify (defence-in-depth on top of server-side sanitisation), then render inside a constrained container.
- Loading state while body fetches; error state if 503/404 from the source.
- Collapsible "Show original headers" section below the body.
- **Acceptance**: plain text and HTML emails render correctly; script/iframe content is gone; remote images load but CID images stay broken.

### D3. EmailAttachments list + download
**Status**: ☑ · **Depends on**: D1, P3P4
- Renders one row per attachment: filename, content-type icon, size, download button.
- Download button hits `GET /api/email/:id/attachments/:name` (server sets `Content-Disposition: attachment`).
- Empty state when no attachments (hidden, not "No attachments" — saves vertical space).
- **Acceptance**: downloading a PDF works; bytes match the source; oversized attachments (>50 MB) still stream without buffering.

### D4. Detail page WS subscription
**Status**: ☑ · **Depends on**: D1
- The detail page subscribes to email-related events for its current `emailId` so chip changes from any action surface here too.
- Uses `useSessionSubscription` for any spawned action sessions (handled in P3).
- **Acceptance**: filing an email from another tab/window updates the detail page's chip + filed-status indicator in real time.

---

## P3 — Action toolbar + inline session stream

### A1. EmailActionToolbar wired to /api/email/actions
**Status**: ☑ · **Depends on**: D1, P3P5
- Wraps Phase 1.5's `<ActionToolbar module="email" contextId={emailId}>` with email-specific dispatch.
- Pulls actions from `useModuleActions('email')` (Phase 1.5's `/api/email/actions` discovery).
- Action click → dispatch → returns `sessionId` → opens an inline session stream below the toolbar.
- `requires_confirmation: true` actions interpose an AlertDialog before dispatch.
- **Acceptance**: clicking `File to project` dispatches a spawned session; the session id flows to the inline stream.

### A2. Inline session stream below the action toolbar
**Status**: ☑ · **Depends on**: A1
- After dispatch, render `<InlineSessionStream sessionId={spawnedSessionId} open onOpenChange={…} />` between the toolbar and the body.
- Stream stays open until the session ends OR the user navigates away from the detail page.
- Banner inside the stream shows `Open in full chat` link when `session.awaiting_input` fires (per ADR-0006 — notification tray is the authoritative cross-page surface).
- **Acceptance**: a filing session streams its assistant deltas + tool chips in place; the user can keep reading the email while the agent works.

### A3. Row-level action chip (EmailRowChip)
**Status**: ☑ · **Depends on**: A1
- `<EmailListRow>` renders the chip from the `email-chips` store keyed by `emailId`.
- States: `▶ filing…` (running, with subtle spinner) → `✓ filed to 24001` (success, fades to neutral after 30s) → `✗ failed` (with hover tooltip).
- Clicking the success chip navigates to the target project.
- **Acceptance**: starting an action shows the running chip; completion updates to the success/failure variant; navigating away and back preserves the chip from the WS store.

---

## P4 — `file-to-project` end-to-end

### F1. Skill auto-resolves single-match projects
**Status**: ☑ · **Depends on**: A1
- Server-side: the `file-to-project` skill (already exists in `modules/email/skills/file-to-project/`) parses the email's body for a project number reference (`24001`, `Project 24001`, etc.). If exactly one project matches, file directly — no `request_user_input`.
- The skill's `prompt_template` already covers the flow; this task verifies the skill's tool sequence: `list-projects` → match → `file-to-project` core tool → return.
- **Acceptance**: an email mentioning exactly one existing project number files directly into that project, no notification tray interaction.

### F2. Ambiguous-match → request_user_input → tray pick
**Status**: ☑ · **Depends on**: F1
- When the skill can't disambiguate (multiple project candidates, none matching, or no reference at all), it calls `request_user_input` with options like:
  ```
  question: "Which project should I file 'RFI from owner' into?"
  options: [
    { label: "24001 — Riverside Reno", value: "<projectId>" },
    { label: "24002 — Brookfield Tower", value: "<projectId>" },
    { label: "+ Create new project", value: "create-new" },
  ]
  ```
- Notification tray (Phase 1.5 S4) surfaces it; user clicks an option → answer route resolves the notification + posts the value as the session's next message → skill continues with the chosen projectId.
- **Acceptance**: an ambiguous email triggers a tray notification; clicking the chosen project files the email and the chip flips to `✓ filed to <number>`.

### F3. Filed email's folder layout matches v2-business-flow spec
**Status**: ☑ · **Depends on**: F1
- Folder convention: `projects/<n>/in/<date> - <slug>/email.md` + attachment files.
- `email.md` has frontmatter (from / subject / received_at / source) and a markdown body from the rendered HTML/text.
- The service's `fileToProject` core tool already does this — verify against the spec.
- **Acceptance**: filing an email creates the expected folder structure; `email.md` opens correctly in markdown preview; attachments are saved alongside.

---

## P5 — `create-new-project` + `scope-extractor` flows

### S1. `create-new-project` skill end-to-end
**Status**: ☑ · **Depends on**: F2
- The "+ Create new project" option in the ambiguous-match flow (F2) dispatches `create-new-project` skill, which:
  1. Calls `request_user_input` for project metadata (number, name, client).
  2. Creates the project via `projects.createProject`.
  3. Files the email into the new project.
- Notification tray drives steps 1-2 just like F2.
- **Acceptance**: picking "+ Create new project" from the ambiguous-match tray walks the user through creation + filing in one flow.

### S2. `scope-extractor` skill writes scope.md
**Status**: ☑ · **Depends on**: F1
- Skill action: button on the email detail view dispatches `scope-extractor`. The skill:
  1. Resolves the target project (auto-match or `request_user_input`).
  2. Reads the email body.
  3. Generates a structured `scope.md` (frontmatter + markdown sections).
  4. Writes to `projects/<n>/in/<date>/scope.md`.
- The output unblocks Phase 4's "Generate estimate from scope" Ask Agent menu item.
- **Acceptance**: running the skill on an RFI email produces a usable `scope.md` that Phase 4's build-estimate skill can read.

---

## P6 — Project Emails tab content

### X1. Replace the Phase 2 EmailsTab placeholder
**Status**: ☑ · **Depends on**: P3P1, P3P6, I1
- In `src/web/src/routes/modules/projects/components/tabs/EmailsTab.tsx`, replace the `<EmptyState>` with a real list.
- Calls `GET /api/email?projectId=:id&filed=true`. Renders compact rows like the inbox but without the filed chip (everything here is filed by definition).
- Row click navigates to `/email/<id>` (the email's own detail page).
- Empty state ("No emails filed to this project yet.") when none.
- **Acceptance**: filing an email to project 24001 makes it appear in `/projects/24001?tab=emails` without a manual refresh.

---

## P7 — Polish + agent QA

### Q1. Toast on action failure (consistent error UX)
**Status**: ☑ · **Depends on**: A1
- All action dispatch failures (network error, 422, 409 from a skill) surface as sonner toasts. The inline stream also shows the error inline if a session started.
- **Acceptance**: dispatching a broken action shows a toast with a useful error code; the row chip flips to `✗ failed`.

### Q2. Maildir source health indicator
**Status**: ☑ · **Depends on**: I4, P3P7
- The `GET /api/health` response gets an `emailSource: { kind, ok, lastPollAt }` field. Top bar shows a small warning when the source is offline.
- **Acceptance**: shutting down the maildir watcher (e.g. revoking folder permissions) surfaces a warning in the top bar.

### Q3. Empty / loading / error states for body fetch
**Status**: ☑ · **Depends on**: D2
- Loading: prose skeleton matching the body's centred column.
- Error: friendly message with a Retry button.
- Empty (rare — body deleted upstream): "This email's body is no longer available from the source."
- **Acceptance**: each state renders correctly under deliberate failure injection.

---

## Sub-phase — GraphEmailSource (landed 2026-05-29)

Landed after Phase 3 shipped with `MaildirEmailSource`. Note: the original
plan pencilled in the OAuth2 **device-code** flow; the implementation uses the
**authorization-code redirect** flow instead, mirroring the existing QBO
integration 1:1 (reused `OAuthStateStore`, connect/callback routes, redirect-
button UI, query-string toast). Redirect is the natural fit because the app is
driven from a browser on the same loopback host. See
[`m365-oauth.test.ts`](../../tests/m365-oauth.test.ts),
[`graph-email-source.test.ts`](../../tests/graph-email-source.test.ts).

### G1. Microsoft Graph OAuth2 authorization-code redirect flow
**Status**: ☑ · **Depends on**: P3 complete
- Confidential client, single-tenant/single-user. Tokens encrypted at rest via
  the shared secret-vault (`src/storage/secret-vault.ts`) — one vault instance
  now serves QBO and M365. Routes: `GET /api/integrations/m365/connect` +
  `/callback`, `POST /api/integrations/m365/disconnect` in
  [`modules/email/src/routes.ts`](../../modules/email/src/routes.ts); client in
  [`src/modules/m365/auth.ts`](../../src/modules/m365/auth.ts).
- **Acceptance**: operator connects M365 from Settings → Integrations; encrypted
  tokens persist across restarts; on-demand refresh re-encrypts + re-persists.

### G2. `GraphEmailSource` implementation
**Status**: ☑ · **Depends on**: G1
- Implements the `EmailSource` interface in
  [`modules/email/src/sources/graph.ts`](../../modules/email/src/sources/graph.ts):
  `list`/`get`/`getBody` (HTML sanitised) / `fetchAttachment` / `markRead`. No
  `watch()` — Graph push needs a public webhook (out of scope); a
  `GraphEmailPoller` (mirrors `QboPoller`) polls every `EMAIL_POLL_INTERVAL_MIN`.
  Listing uses `$filter`/`$top`/`$orderby` (delta-query incremental sync deferred
  — `pollSource` already dedups by `(sourceKind, sourceId)`).
- **Acceptance**: the same panel renders with Graph as the source; no email
  list/detail frontend changes needed.

### G3. Integrations tab gains "Microsoft 365 Email"
**Status**: ☑ · **Depends on**: G1
- Connect / Disconnect, account label, connected-at, token expiry, last poll,
  last error —
  [`M365IntegrationPanel.tsx`](../../src/web/src/routes/settings/M365IntegrationPanel.tsx)
  stacked above the QBO row in `IntegrationsTab`.
- **Acceptance**: tab UI matches the QBO row from Phase 5.

### G4. `EMAIL_SOURCE=graph|maildir` env switch + per-source config
**Status**: ☑ · **Depends on**: G2
- `EMAIL_SOURCE` env switch (restart required) in
  [`src/server/config.ts`](../../src/server/config.ts); when unset, inferred
  (`graph` if M365 creds present, else `maildir` if `EMAIL_MAILDIR_PATH` set,
  else none). The `/api/health` `emailSource` block reports the graph kind.
- **Acceptance**: changing the env + restart reads from the chosen source.

---

## Out of scope for Phase 3

- **Bulk operations** (multi-select archive / mark / move).
- **Outbound email** (`send_reply`, `send_proposal`, etc.).
- **Folder navigation** beyond Inbox.
- **Full-body search**.
- **Inline image preview** for `cid:` references.

---

## Cross-references

- Impl spec: [`./phase-3-email-impl-spec.md`](./phase-3-email-impl-spec.md)
- Domain spec: [`./v2-business-flow.md#modulesemail`](./v2-business-flow.md#modulesemail)
- Phase 2 prerequisite (Emails tab container): [`./phase-2-projects-impl-spec.md`](./phase-2-projects-impl-spec.md), [`./phase-2-projects-punchlist.md`](./phase-2-projects-punchlist.md)
- Phase 1.5 conventions: [`./phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md), [`./phase-1.5-react-punchlist.md`](./phase-1.5-react-punchlist.md)
- ADRs: [`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md), [`../adr/0007-module-panel-conventions.md`](../adr/0007-module-panel-conventions.md)
- Server-side: [`../../modules/email/`](../../modules/email/)

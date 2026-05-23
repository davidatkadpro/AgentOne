# Phase 3 — Email panel implementation spec

Implementation-level scaffolding for the Email module's React panel + the cross-module wiring it adds to the Projects' **Emails** tab. The module's domain spec (entities, source interface, actions, business rules) lives in [`v2-business-flow.md`](./v2-business-flow.md#modulesemail); this doc answers "how the code is wired" — folder layout, TypeScript types, TanStack Query cache keys, component prop signatures, URL schema, body-rendering pipeline, and the backend route gaps Phase 3 has to close.

Mirrors [`phase-2-projects-impl-spec.md`](./phase-2-projects-impl-spec.md). Read [`phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md) for the foundational conventions; this doc only adds what's specific to Email.

Last reviewed: 2026-05-23. Treat as living.

---

## 0. Scope reminder

Phase 3 ships:
- The **Email panel** (inbox list + detail view with body + actions toolbar + inline session stream).
- **`file-to-project` skill end-to-end** including the ambiguous-match `request_user_input` → notification-tray-pick → project-folder write → confirmation chip flow.
- **`create-new-project` skill** flow (button on the inbox triggers it; reuses `file-to-project` machinery after the project is created).
- **`scope-extractor` skill** flow (writes `scope.md` into the project's `in/` folder — unblocks Phase 4's "Generate estimate from scope").
- **Project `Emails` tab content** — list of emails filed to the project, dropped into the existing Phase 2 placeholder.
- **Source poller**: `MaildirEmailSource` only. `GraphEmailSource` is deferred to a sub-phase once OAuth is set up.

Phase 3 does **not** ship: outbound email (no send), bulk multi-select operations, folder navigation (Sent/Trash/Drafts — by design), Graph OAuth wiring (sub-phase), full-text body search (the local `email` table is an index, not a body mirror).

---

## 1. Folder layout

```
src/web/src/routes/modules/email/
├── EmailRoute.tsx                 # /email — inbox list
├── EmailDetailRoute.tsx           # /email/:emailId — detail with body + actions
├── components/
│   ├── EmailListRow.tsx           # 2-line compact row
│   ├── EmailHeader.tsx            # subject + sender + date + filed chip
│   ├── EmailBody.tsx              # sanitised HTML or plain text
│   ├── EmailAttachments.tsx       # list of attachments + download buttons
│   ├── EmailActionToolbar.tsx     # wraps <ActionToolbar> with email-specific dispatch + inline session stream
│   ├── EmailRowChip.tsx           # ▶ filing… → ✓ filed to <number> / ✗ failed
│   ├── EmailKpiStrip.tsx          # Unread · Filed · Has attachments
│   └── EmailRefreshButton.tsx     # POST /api/email/poll
└── hooks/
    └── useEmailFilter.ts          # ?filter=unread|filed|attached URL helpers
```

Add a project-tab adapter:

```
src/web/src/routes/modules/projects/components/tabs/
├── EmailsTab.tsx                  # Phase 2 placeholder replaced — pulls /api/email?projectId=:id
```

API hooks alongside the existing ones:

```
src/web/src/api/
├── email.ts                       # NEW — useEmails, useEmail, useEmailBody, useMarkRead, usePollEmail
```

**Pinned ordering rules** stay the same as Phase 1.5 + 2 — no React in `lib/`, no fetching in `components/`, all routes own their data via `api/` hooks.

---

## 2. TypeScript types

Add to `src/web/src/types/domain.ts`:

```ts
export interface Email {
  id: string
  sourceKind: string                  // 'maildir' | 'graph'
  sourceId: string
  receivedAt: number
  fromAddress: string
  fromName: string | null
  subject: string | null
  snippet: string | null
  hasAttachments: boolean
  isRead: boolean
  filedProjectId: string | null
  filedFolderPath: string | null
  filedAt: number | null
  metadata: Record<string, unknown>
  createdAt: number
}

export interface EmailAttachmentSummary {
  filename: string
  bytes: number
  contentType: string | null
}

/** Rendered body for the detail view. Body comes from the EmailSource adapter
 *  at request time (not stored in the `email` index table). */
export interface EmailBody {
  emailId: string
  kind: 'html' | 'text'
  /** Sanitised HTML (DOMPurify-ready) or plain text. */
  content: string
  attachments: EmailAttachmentSummary[]
}

/** Per-row action chip state, derived from `email.action_started` /
 *  `email.action_completed` events. Lives in the Zustand store keyed by emailId. */
export interface EmailActionChip {
  emailId: string
  action: string
  sessionId: string
  status: 'running' | 'completed' | 'failed'
  result?: { projectId?: string; projectNumber?: string }
  startedAt: number
  endedAt?: number
}

export interface EmailPollResult {
  ingested: number
  skipped: number
  errors: number
}
```

### REST request/response types

```ts
// GET /api/email
export interface ListEmailsQuery {
  isRead?: boolean
  filed?: boolean
  hasAttachments?: boolean
  projectId?: string
  limit?: number
}
export interface ListEmailsResponse { emails: Email[] }

// GET /api/email/:id
export interface EmailDetailResponse { email: Email }

// GET /api/email/:id/body  — NEW
//   Returns the rendered body. Server reads the EmailSource on demand.
//   404 if the source is offline / the message no longer exists upstream.
export type EmailBodyResponse = EmailBody

// PATCH /api/email/:id
export interface UpdateEmailRequest { isRead: boolean }
export interface UpdateEmailResponse { email: Email }

// POST /api/email/poll
export type PollEmailResponse = EmailPollResult
//   503 — NO_EMAIL_SOURCE_CONFIGURED

// GET /api/email/:id/attachments/:name  — NEW
//   Streams the attachment bytes with Content-Disposition: attachment.

// POST /api/email/actions  — already exists, dispatches a skill action
//   (covered by Phase 1.5's discovery convention from P2S1)
export interface DispatchEmailActionRequest {
  action: string                       // SKILL.md `name`
  contextId: string                    // email id (was `emailId` in v1; renamed for ADR-0007 symmetry)
  args?: Record<string, unknown>
}
export interface DispatchEmailActionResponse {
  sessionId: string
  action: string
}
```

> Note: existing routes live under `/api/v1/email/*`. The spec assumes Phase 3 normalises them to `/api/email/*` (matches ADR-0007's `/api/<module>/<entity>` convention used everywhere else). Tracked as P3P1.

---

## 3. TanStack Query cache keys

Extend `lib/query-client.ts`:

```ts
export const queryKeys = {
  // … existing …
  emails: {
    all: () => ['emails'] as const,
    list: (opts?: ListEmailsQuery) => ['emails', 'list', opts ?? {}] as const,
    detail: (id: string) => ['emails', 'detail', id] as const,
    body: (id: string) => ['emails', 'body', id] as const,
  },
} as const
```

**Mutation → invalidation:**

| Mutation | Invalidates |
|---|---|
| `useMarkRead(id)` | `emails.list()` (all variants), `emails.detail(id)` |
| `usePollEmail()` | `emails.list()` (all variants) — new emails surface via WS, but the manual button forces a refresh |
| `useDispatchAction('email')` | nothing (chip state is WS-driven via `email.action_*`) |

**WS → cache invalidation** additions to the global dispatch fanout:

| Event | Invalidates |
|---|---|
| `email.received` | `emails.list()` (all variants) |
| `email.read` | `emails.list()`, `emails.detail(emailId)` |
| `email.filed` | `emails.list()`, `emails.detail(emailId)`; if `projectId` known, `projects.detail(projectId)` (Emails tab); `projects.activity(projectId)` |
| `email.action_started`, `email.action_completed` | nothing in TanStack cache — these drive the EmailActionChip store directly |

**Stale times**:
- `emails.list()`: 30s (default) — drops to immediate when an `email.received` fires.
- `emails.detail(id)`: 30s.
- `emails.body(id)`: 5 min — bodies don't change after delivery; large pages stay cheap.

---

## 4. Zustand additions

### 4.1 `stores/email-chips.ts` — per-row action chip state

A new small store keyed on `emailId` tracking the most recent action chip. Derived from `email.action_started` / `email.action_completed` events; cleared when the same email gets another action started (chip replaces, not stacks).

```ts
interface EmailChipsState {
  byEmailId: Record<string, EmailActionChip>
  applyEvent(event: AgentEvent): void
  /** Optional manual clear when the user dismisses a stuck chip. */
  clear(emailId: string): void
}
```

Reducer wiring:

| Event | Effect |
|---|---|
| `email.action_started` | replace `byEmailId[emailId]` with `{ status: 'running', sessionId, action, startedAt }` |
| `email.action_completed` (ok: true) | merge `{ status: 'completed', endedAt, result }` |
| `email.action_completed` (ok: false) | merge `{ status: 'failed', endedAt }` |

The chip displays in `<EmailListRow>` and `<EmailHeader>`. After 30s, the row-side chip fades to a less prominent "✓ filed" badge; the header chip stays full-detail until the user navigates away.

### 4.2 No new session-stream slice

Action sessions reuse the existing `session-stream` store — `<EmailActionToolbar>` mounts `<InlineSessionStream sessionId={spawnedSessionId}>` exactly like Phase 2's Projects panel does.

---

## 5. Component prop signatures

### 5.1 List route

```ts
// EmailRoute.tsx — mounted at /email
// No props. Reads ?filter= from URL.

// components/EmailListRow.tsx
interface EmailListRowProps {
  email: Email
  isActive: boolean
  chip: EmailActionChip | null     // from useEmailChip(emailId)
}

// components/EmailKpiStrip.tsx
interface EmailKpiStripProps {
  unreadCount: number
  filedCount: number
  attachmentsCount: number
  activePillId: 'unread' | 'filed' | 'attached' | null
  onPillClick(id: 'unread' | 'filed' | 'attached' | null): void
}

// components/EmailRefreshButton.tsx
// No props. Calls usePollEmail() and shows the result count briefly via sonner toast.
```

### 5.2 Detail route

```ts
// EmailDetailRoute.tsx — mounted at /email/:emailId
// No props. Reads :emailId from URL.

// components/EmailHeader.tsx
interface EmailHeaderProps {
  email: Email
  chip: EmailActionChip | null
}

// components/EmailBody.tsx
interface EmailBodyProps {
  emailId: string                  // hooks call useEmailBody(emailId)
}

// components/EmailAttachments.tsx
interface EmailAttachmentsProps {
  emailId: string
  attachments: EmailAttachmentSummary[]
}

// components/EmailActionToolbar.tsx
interface EmailActionToolbarProps {
  emailId: string
  /** Filter applied to actions by surface — `'action'` for the row of named
   *  buttons, `'ask_agent'` would normally come via the menu but Email uses
   *  the toolbar as the primary surface. */
  onSessionSpawned(sessionId: string): void
}
```

### 5.3 Project Emails tab

```ts
// routes/modules/projects/components/tabs/EmailsTab.tsx
interface EmailsTabProps { projectId: string }
// Renders <EmailListRow> rows filtered to GET /api/email?projectId=:id&filed=true.
// Empty state: "No emails filed to this project yet."
```

### 5.4 Body rendering pipeline

`<EmailBody>` is the trickiest component. Pipeline:

1. `useEmailBody(emailId)` calls `GET /api/email/:id/body`. The server's `EmailSource` returns `{ kind, content, attachments }`.
2. For `kind === 'text'`: render `<pre className="whitespace-pre-wrap text-sm">`. No further processing.
3. For `kind === 'html'`:
   - Server already strips scripts + iframes + form posts (server-side sanitization via the EmailSource adapter — see P3P3 backend task).
   - Client adds DOMPurify defence-in-depth: configure ALLOWED_TAGS = blocks + inline formatting + links + images; ALLOWED_ATTR omits everything starting with `on*`, plus `style` (preventing CSS-based exfil).
   - Render inside a sandboxed `<iframe sandbox="allow-same-origin">` would be ideal but is excessive for v2 — a constrained div with the sanitized HTML is enough given the single-user trust model.
4. Image fetching: keep CID-prefixed `cid:` links broken (no inline image rendering in v2). Remote `https://` images load directly (operator is single-user; tracking pixels are a future concern).
5. The container has a `Show original headers` collapsible at the top for power users.

---

## 6. URL schema

| Route | Search params |
|---|---|
| `/email` | `?filter=unread\|filed\|attached`, `?search=<term>` (client-side filter on subject + sender + snippet) |
| `/email/:emailId` | none — detail is fully driven by the URL path |
| `/projects/:projectId?tab=emails` | inherits Phase 2 routing; renders `<EmailsTab>` |

Deep-link cases:
- `/email?filter=unread` — opens inbox filtered to unread
- `/email/<id>` — opens detail and the body fetch fires immediately; auto-marks read on load
- Filed-status chip in `<EmailListRow>` navigates `/projects/<projectId>?tab=emails`

---

## 7. Backend route gaps to close in Phase 3

| # | Route | Reason |
|---|---|---|
| P3P1 | Alias `/api/v1/email/*` → `/api/email/*` | ADR-0007 convention — symmetric with Phase 2's projects normalisation |
| P3P2 | `GET /api/email/:id/body` | Body rendering (HTML or plain). Server reads the EmailSource on demand and sanitises HTML before returning |
| P3P3 | Server-side HTML sanitiser inside the EmailSource adapter | Belt-and-braces — strip `<script>`, `<iframe>`, `<object>`, `on*` attrs, `javascript:` URLs, `style` attrs before the body ever leaves the server. The frontend's DOMPurify is defence-in-depth |
| P3P4 | `GET /api/email/:id/attachments/:name` | Attachment download. Streams bytes with `Content-Disposition: attachment; filename="…"`. 404 if the source no longer has it; 503 if EmailSource is offline |
| P3P5 | `POST /api/email/actions` — accept ADR-0007's `contextId` + `args` shape (currently expects `emailId`) | Symmetry with the other modules' dispatch routes. Add an alias path or accept both keys for one release |
| P3P6 | `email.filed` event payload gains `projectId` (already there) — verify it's denormalised so WS dispatcher can route invalidation correctly | Already specced in v2-business-flow; the Phase 2 punch list P2P11 covers cross-module event payloads — re-verify on Email's three events |
| P3P7 | `MaildirEmailSource` fs-watcher emits `email.received` on new `.eml` arrival without polling | Spec says "no client polling" — server should still detect new mail without requiring `POST /api/email/poll`. Use `chokidar` on the maildir root |
| P3P8 | `POST /api/email/:id/file-to-project` route already exists but never spawns a session via the action dispatch path — Phase 3 deletes it in favour of `POST /api/email/actions { action: 'file-to-project' }` | Single entry point. Delete the orphan to avoid drift |

Items P3P5 + P3P8 are cleanup; the rest are real new work (each ~1-3 hours).

---

## 8. Phasing within Phase 3

The punch list orders work so each level ships a useful slice:

1. **P0 — Backend route normalisation + body/attachment routes** (P3P1-P3P4, P3P7)
2. **P1 — Inbox list** (`/email`, KPI strip, row design, refresh button)
3. **P2 — Detail view** (header + body + attachments + read/unread)
4. **P3 — Action toolbar + inline session stream** (wires existing dispatch through `<ActionToolbar>`)
5. **P4 — `file-to-project` end-to-end** including ambiguous-match flow via notification tray
6. **P5 — `create-new-project` + `scope-extractor`** complete user flows
7. **P6 — Project Emails tab content** (replace Phase 2 placeholder)
8. **P7 — Polish + agent QA**

Each level is shippable on its own. Estimate: **6-10 days** for a focused contributor (the v2-business-flow's "1-2 weeks" matches at the high end if Graph OAuth is included; Phase 3 here defers Graph to a sub-phase).

---

## 9. Sub-phase: GraphEmailSource

Reserved for after Phase 3 ships with `MaildirEmailSource`. Adds:
- Microsoft Graph OAuth2 device-code flow (single-tenant, single-user).
- `GraphEmailSource` adapter implementing the same `EmailSource` interface.
- Settings → Integrations tab gains a `Microsoft 365 Email` row alongside QBO.
- Configuration: `EMAIL_SOURCE=graph|maildir` env switch + per-source config via `settings.json`.

Estimated 3-5 days; tracked separately when ready.

---

## 10. What this spec does NOT pin

- **Bulk operations** (multi-select archive / mark / move). Single-message only in v2.
- **Outbound email** — `send_reply`, `send_proposal`. Out per v2-business-flow.
- **Folder navigation** — no Sent / Trash / Drafts browser. Filed emails surface contextually in their project's Emails tab.
- **Full-body search** — local `email` table is an index. Search filters on subject + sender + snippet only.
- **Inline image preview** — `cid:` links stay broken; remote images load directly.
- **GraphEmailSource** — separate sub-phase after Phase 3 ships with Maildir.

---

## 11. Cross-references

- Phase 3 punch list (work breakdown): [`./phase-3-email-punchlist.md`](./phase-3-email-punchlist.md)
- Module domain spec: [`./v2-business-flow.md#modulesemail`](./v2-business-flow.md#modulesemail)
- Phase 2 (Projects) — provides the Emails tab container that this phase fills: [`./phase-2-projects-impl-spec.md`](./phase-2-projects-impl-spec.md)
- Phase 1.5 conventions: [`./phase-1.5-frontend-impl-spec.md`](./phase-1.5-frontend-impl-spec.md)
- Server service: [`../../modules/email/src/service.ts`](../../modules/email/src/service.ts)
- Server actions (already implements discovery + dispatch): [`../../modules/email/src/actions.ts`](../../modules/email/src/actions.ts)

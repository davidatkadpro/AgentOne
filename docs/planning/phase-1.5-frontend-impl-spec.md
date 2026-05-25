# Phase 1.5 — React frontend implementation spec

The implementation-level scaffolding for the React rewrite called for in [ADR-0006](../adr/0006-frontend-shell-architecture.md), [ADR-0007](../adr/0007-module-panel-conventions.md), and broken into work items in [`./phase-1.5-react-punchlist.md`](./phase-1.5-react-punchlist.md). Where the punch list answers "what to build" and the FRONTEND-HANDOFF answers "what the server returns," this doc answers "how the code is wired" — folder layout, TypeScript types, TanStack Query cache keys, Zustand store shape, WS-event reducer wiring, component prop signatures, and URL param shapes.

Last reviewed: 2026-05-23. Treat as living — update when contracts shift.

---

## 1. Folder layout (`src/web/`)

The rewrite ships in a new workspace at [`src/web/`](../../src/web/). The legacy [`src/frontend/`](../../src/frontend/) stays served until R1 (the legacy removal item in the punch list).

```
src/web/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.cjs
├── src/
│   ├── main.tsx                  # ReactDOM.createRoot + providers
│   ├── App.tsx                   # <RouterProvider router={router} />
│   ├── router.tsx                # createBrowserRouter() — see §7
│   ├── lib/
│   │   ├── api.ts                # fetch wrapper, ApiError, /api prefix
│   │   ├── ws.ts                 # WebSocket client, subscribe/unsubscribe
│   │   ├── ws-backoff.ts         # ported from src/frontend/ws-backoff.js
│   │   ├── slash-parser.ts       # ported from src/frontend/slash-parser.js
│   │   ├── time.ts               # recency bucketing (Today/Week/Earlier)
│   │   └── markdown.tsx          # react-markdown wrapper w/ gfm + highlight
│   ├── types/
│   │   ├── events.ts             # Zod schemas + types for AgentEvent
│   │   ├── domain.ts             # Session, Turn, Notification, Profile, etc.
│   │   └── api.ts                # request/response types for every REST endpoint
│   ├── api/                      # one file per endpoint group; each exports useXxx() hooks
│   │   ├── health.ts             # useHealth()
│   │   ├── sessions.ts           # useSessions(), useSession(id), useCreateSession(), useSendMessage(), useCancelTurn(), useRenameSession()
│   │   ├── profiles.ts           # useProfiles(), useCreateProfile(), useUpdateProfile(), useDeleteProfile()
│   │   ├── drafts.ts             # useDrafts()
│   │   ├── commands.ts           # useCommands(), useRunCommand()
│   │   ├── notifications.ts      # useNotifications(), useAnswerNotification(), useUpdateNotification()
│   │   └── module-actions.ts     # useModuleActions(moduleName), useDispatchAction(moduleName)
│   ├── stores/
│   │   ├── session-stream.ts     # Zustand: per-session WS-derived state
│   │   ├── notifications.ts      # Zustand: unresolved-attention badge state
│   │   ├── ui.ts                 # Zustand: tray-open, toast queue, theme
│   │   └── ws.ts                 # Zustand: connection status + per-session subscription set
│   ├── shell/
│   │   ├── AppShell.tsx          # CSS-grid layout (top bar + sidebar + main)
│   │   ├── TopBar.tsx
│   │   ├── Sidebar.tsx
│   │   ├── SidebarNav.tsx
│   │   ├── SessionList.tsx
│   │   ├── SessionListRow.tsx
│   │   ├── NotificationTray.tsx
│   │   ├── NotificationToastQueue.tsx
│   │   ├── NewChatDialog.tsx
│   │   └── ThemeProvider.tsx
│   ├── routes/
│   │   ├── chat/
│   │   │   ├── ChatRoute.tsx
│   │   │   ├── MessageList.tsx           # extracted; reused by <InlineSessionStream>
│   │   │   ├── MessageItem.tsx
│   │   │   ├── ToolChip.tsx
│   │   │   ├── Composer.tsx
│   │   │   ├── SlashOverlay.tsx
│   │   │   ├── CancelButton.tsx
│   │   │   └── ProfileMismatchBanner.tsx
│   │   ├── drafts/DraftsRoute.tsx
│   │   ├── skills/
│   │   │   ├── SkillsRoute.tsx
│   │   │   └── SkillDrawer.tsx
│   │   ├── settings/
│   │   │   ├── SettingsRoute.tsx         # tab routing via ?tab=
│   │   │   ├── ProfilesTab.tsx
│   │   │   ├── ProfileEditor.tsx
│   │   │   ├── ProfileRestartBanner.tsx
│   │   │   ├── ThemeTab.tsx
│   │   │   ├── HooksTab.tsx
│   │   │   └── IntegrationsTab.tsx
│   │   ├── modules/
│   │   │   ├── EmailRoute.tsx
│   │   │   ├── ProjectsRoute.tsx
│   │   │   ├── ProposalsRoute.tsx
│   │   │   └── InvoicingRoute.tsx
│   │   └── NotFound.tsx
│   ├── components/
│   │   ├── ui/                   # shadcn primitives (Button, Sheet, Dialog, AlertDialog, …)
│   │   ├── module/               # the five ADR-0007 components (M1–M5)
│   │   │   ├── ModulePanel.tsx
│   │   │   ├── ActionToolbar.tsx
│   │   │   ├── InlineSessionStream.tsx
│   │   │   ├── AskAgentMenu.tsx
│   │   │   ├── KpiStrip.tsx
│   │   │   └── StatusActionButton.tsx
│   │   └── shared/               # generic helpers: EmptyState, RelativeTime, CopyButton
│   └── styles/
│       └── globals.css           # Tailwind directives + CSS variables for theme
└── tests/                        # Vitest + @testing-library/react; .test.tsx co-located OK too
```

**Pinned ordering rules:**

- `lib/` has no React imports. Pure logic only — slash parser, WS backoff, REST client, time bucketing. This is what gets unit-tested without a DOM.
- `types/` has no runtime code except Zod schemas. Everything else is `type` / `interface`.
- `api/` is the boundary between TanStack Query and `lib/api.ts`. No `useQuery`/`useMutation` call should live outside `api/`.
- `stores/` owns Zustand. No `useQuery` inside stores; no `useStore` calls inside `api/`. The two are decoupled — REST cache and WS-derived state never share the same atom.
- `routes/` and `shell/` are the only places that may call both `api/` and `stores/`.
- `components/module/` is pure render + callbacks. No fetching, no store access — props in, JSX out.

The legacy `src/frontend/client.js` is **not** a model for the file structure. Don't carry over its inline event-switch.

---

## 2. TypeScript types

### 2.1 Domain types (`src/web/types/domain.ts`)

These mirror the server's persisted shapes, hand-translated from [`src/core/types.ts`](../../src/core/types.ts) and the response shapes in [FRONTEND-HANDOFF.md](../historical/FRONTEND-HANDOFF-2026-05.md). Keep them in sync with the server schema; don't import from `src/` directly (the Vite build doesn't have visibility into server code).

```ts
export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type SessionState = 'active' | 'awaiting_input' | 'archived'

export interface Session {
  id: string
  title: string | null
  agentProfile: string
  createdAt: number
  state: SessionState
  spawnedBy: string | null
}

export interface Turn {
  id: string
  sessionId: string
  role: Role
  content: string
  tokenCount: number
  createdAt: number
  compressedFrom?: string | null
  toolCallId?: string | null
}

export interface ToolCallRecord {
  id: string                      // server's storage id
  toolCallId: string              // LLM-side id (used to correlate with WS events)
  turnId: string                  // owning turn — used to bucket by-turn in the store
  tool: string
  argsJson?: string               // populated on /api/sessions/:id detail responses
  resultJson?: string
  ok?: boolean
  durationMs?: number
  createdAt: number               // server always sends this on session-detail rows
}

/** Live tool-call state in the Zustand store. Differs from ToolCallRecord
 *  because it tracks the in-flight transition pending → done/failed. */
export interface ToolChipState {
  toolCallId: string
  tool: string
  status: 'pending' | 'done' | 'failed'
  durationMs?: number
  failCode?: string
  failMessage?: string
  truncated?: boolean             // set when tool.result_truncated fires for this id
}

export interface ProfileListEntry {
  id: string
  description: string | null
  defaultModel: string
  defaultSkills: string[]
  ok: boolean
  error?: string
}

export interface NotificationOption {
  label: string
  value: string
}

export interface Notification {
  id: number                              // server PK is INTEGER AUTOINCREMENT
  kind: 'info' | 'attention_needed' | 'error'
  title: string
  body: string                            // server schema marks NOT NULL
  sessionId: string | null
  module: string | null
  payload: NotificationPayload            // parsed payload_json; server stores `{}` when absent
  status: 'unread' | 'read' | 'resolved' | 'dismissed'
  createdAt: number
  resolvedAt: number | null
}

/** payload_json shape for attention_needed notifications driven by
 *  request_user_input. Anything else falls back to `unknown` and the tray
 *  renders an Open-in-chat link. */
export interface AttentionNeededPayload {
  question: string
  options?: NotificationOption[]
}

export type NotificationPayload = AttentionNeededPayload | Record<string, unknown>

export interface DraftEntry {
  path: string
  sessionId: string
  generatedAt: string             // ISO 8601
  title: string
  noteCount: number
  mtime: string                   // ISO 8601
  bytes: number
}

export interface SkillManifest {
  name: string
  description: string
  category: string
  slashCommand: string | null
  allowedTools: string[]
  bodyMarkdown: string
  ok: boolean
  error?: string
}

export interface ModuleAction {
  name: string
  label: string
  description: string
  icon: string | null
  defaultProfile: string | null
  requiresConfirmation: boolean
  surface: 'action' | 'ask_agent' | 'both'
  tabs: string[]
}

export interface ModuleActionsError {
  skill: string
  error: string
}

export interface HealthResponse {
  status: 'ok'
  model: string
  contextWindow: number
  storageRoot: string
  wikiPrefix: string
  agentProfile: string
  capabilities?: { pandoc: boolean }    // added in P1S4
}
```

### 2.2 REST API types (`src/web/types/api.ts`)

One request + response type pair per endpoint. The hooks in `src/web/api/` reference these; no inline anonymous response types in components.

```ts
// GET /api/sessions
export interface ListSessionsResponse { sessions: Session[] }

// POST /api/sessions
export interface CreateSessionRequest {
  agentProfile?: string
  title?: string | null
  seed?: { spawnedBy: string; initialMessage: string }
}
export interface CreateSessionResponse { session: Session }

// GET /api/sessions/:id
export interface SessionDetailResponse {
  session: Session
  turns: Turn[]
  toolCalls: Record<string /* turnId */, ToolCallRecord[]>
}

// POST /api/sessions/:id/messages
export interface SendMessageRequest { text: string }
export interface SendMessageResponse { ok: true }
export interface ProfileMismatchError {
  error: 'PROFILE_MISMATCH'
  message: string
}

// POST /api/sessions/:id/cancel
export interface CancelTurnResponse {
  outcome: 'cancelled' | 'no_active_turn' | 'unknown_session'
}

// PATCH /api/sessions/:id
export interface RenameSessionRequest { title: string }
export interface RenameSessionResponse { session: Session }

// GET /api/profiles
export interface ListProfilesResponse { profiles: ProfileListEntry[]; current: string }

// POST /api/profiles
export interface CreateProfileRequest {
  id: string
  description?: string | null
  extends?: string | null
  default_model?: string
  default_skills?: string[]
  permissions?: unknown            // pass-through; Zod-validated server-side
  deny_tools?: string[]
  passive_recall?: { enabled: boolean }
  auto_distill?: { enabled: boolean }
}
export type CreateProfileResponse = ProfileListEntry

// PATCH /api/profiles/:id — body is Partial<CreateProfileRequest> minus `id`
export type UpdateProfileRequest = Omit<Partial<CreateProfileRequest>, 'id'>
export type UpdateProfileResponse = ProfileListEntry

// DELETE /api/profiles/:id
export type DeleteProfileResponse = { ok: true }
export type DeleteProfileError =
  | { error: 'ACTIVE_BOOT_PROFILE'; details: { id: string } }
  | { error: 'PROFILE_IN_USE'; details: { id: string; affectedSessions: number } }
  | { error: 'RESERVED_PROFILE'; details: { id: string } }

// GET /api/drafts
export interface ListDraftsResponse { drafts: DraftEntry[] }

// GET /api/commands
export interface CommandDescriptor {
  name: string
  description: string
  usage: string                          // e.g. "/clear" or "/skill <name> [text]"
  requiresSession: boolean                // when true, the slash overlay disables the entry on global routes
  source: 'system' | 'skill'              // system = built-in command; skill = Skill slash_command
  skill?: string                          // qualified Skill name (e.g. "experts/consult") — only when source === 'skill'
}
export interface ListCommandsResponse { commands: CommandDescriptor[] }

// POST /api/sessions/:id/command
export interface RunCommandRequest { name: string; args?: Record<string, unknown>; text?: string }
export interface RunCommandResponse { result: CommandResult }   // CommandResult mirrors src/server/commands/types.ts

// GET /api/notifications  — added by punch list P1S5
export interface ListNotificationsRequest { includeResolved?: boolean }
export interface ListNotificationsResponse { notifications: Notification[] }

// PATCH /api/notifications/:id  — added by punch list P1S5
export interface UpdateNotificationRequest { status: 'read' | 'resolved' | 'dismissed' }
export interface UpdateNotificationResponse { notification: Notification }

// POST /api/sessions/:id/notifications/:notifId/answer  — added by punch list P1S5
//   Convenience route for the tray's option-button click. Server resolves the
//   notification AND posts the value as a user message in one shot, so the
//   tray's "click option → answer agent" feels instant (single round-trip).
//   Without this route the tray would chain PATCH /api/notifications/:id then
//   POST /api/sessions/:id/messages — workable but doubles latency on the
//   most-used tray action.
export interface AnswerNotificationRequest { value: string }
export interface AnswerNotificationResponse { ok: true }

// GET /api/<module>/actions  — per ADR-0007 / v2-business-flow.md
export interface ListModuleActionsResponse {
  actions: ModuleAction[]
  errors: ModuleActionsError[]
}

// POST /api/<module>/actions
export interface DispatchModuleActionRequest {
  action: string
  contextId: string
  args?: Record<string, unknown>
}
export interface DispatchModuleActionResponse {
  sessionId: string
  action: string
}

// Common error envelope returned on any non-2xx
export interface ApiErrorBody {
  error: string
  message?: string
  details?: unknown
}
```

> **Server work required.** The three notifications routes above (`GET /api/notifications`, `PATCH /api/notifications/:id`, `POST /api/sessions/:id/notifications/:notifId/answer`) do not exist yet — tracked as **P1S5** in the punch list. S4 (Notification tray) blocks on them. The single-shot answer route is an explicit choice over two-step chaining; if dropped, the tray's option-click path becomes two sequential mutations.

### 2.3 WebSocket event types (`src/web/types/events.ts`)

Zod schemas mirroring [`src/core/events.ts`](../../src/core/events.ts). Validate every message, drop unknowns with a console warning rather than throwing — the server-side event vocabulary grows over time and the client must degrade gracefully.

```ts
import { z } from 'zod'

// One Zod schema per event variant. Discriminated union on `type`. Example for one variant:
export const MessageAssistantDeltaSchema = z.object({
  type: z.literal('message.assistant.delta'),
  sessionId: z.string(),
  turnId: z.string(),
  delta: z.string(),
})

// … one per event variant in events.ts …

export const AgentEventSchema = z.discriminatedUnion('type', [
  MessageAssistantDeltaSchema,
  // … rest …
])

export type AgentEvent = z.infer<typeof AgentEventSchema>
export type EventType = AgentEvent['type']
export type EventByType<T extends EventType> = Extract<AgentEvent, { type: T }>
```

**Authoritative source:** the server's [`src/core/events.ts`](../../src/core/events.ts). When new variants are added there, mirror them here in the same commit if the frontend should react to them.

### 2.4 ApiError class (`src/web/lib/api.ts`)

```ts
export class ApiError extends Error {
  readonly status: number
  readonly code: string                       // body.error
  readonly details: unknown
  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? body.error)
    this.status = status
    this.code = body.error
    this.details = body.details
  }
}
```

This is what TanStack Query mutations throw. Components check `err instanceof ApiError && err.code === 'PROFILE_MISMATCH'` etc. rather than parsing strings.

---

## 3. TanStack Query cache key map

One source of truth for cache keys. **All keys are tuples** so partial invalidation works (`queryClient.invalidateQueries({ queryKey: ['profiles'] })` invalidates all profile-related queries; `['profiles', 'list']` is more surgical).

```ts
export const queryKeys = {
  health: () => ['health'] as const,

  sessions: {
    all: () => ['sessions'] as const,
    list: () => ['sessions', 'list'] as const,
    detail: (id: string) => ['sessions', 'detail', id] as const,
  },

  profiles: {
    all: () => ['profiles'] as const,
    list: () => ['profiles', 'list'] as const,
  },

  drafts: {
    list: () => ['drafts', 'list'] as const,
  },

  commands: {
    list: () => ['commands', 'list'] as const,
  },

  notifications: {
    all: () => ['notifications'] as const,
    list: (opts?: { includeResolved?: boolean }) =>
      ['notifications', 'list', opts?.includeResolved ?? false] as const,
  },

  skills: {
    list: () => ['skills', 'list'] as const,
    detail: (name: string) => ['skills', 'detail', name] as const,
  },

  moduleActions: {
    list: (module: string) => ['module-actions', module] as const,
  },
} as const
```

**Mutation invalidation rules** (mutations are the only thing that writes to the REST cache; everything else is via WS-derived store invalidation):

| Mutation | Invalidates |
|---|---|
| `useCreateSession` | `sessions.list()` (then router navigates to `/chat/<id>` which mounts `sessions.detail`) |
| `useSendMessage` | nothing in TanStack cache. **Optimistically appends** a placeholder user turn to `session-stream.turns` (id: `optimistic-<uuid>`) so the composer feels instant. `message.user.received` (WS) reconciles by replacing the placeholder; on mutation failure the placeholder is removed and the error surfaces as a toast |
| `useCancelTurn` | nothing — `turn.cancelled` event closes the loop |
| `useRenameSession` | `sessions.list()`, `sessions.detail(id)` |
| `useCreateProfile` | `profiles.list()` |
| `useUpdateProfile(id)` | `profiles.list()` |
| `useDeleteProfile(id)` | `profiles.list()` |
| `useAnswerNotification` | `notifications.list({ includeResolved: false })`, `notifications.list({ includeResolved: true })` |
| `useUpdateNotification` | same as above |
| `useDispatchAction(module)` | nothing — spawned session id flows back through the dispatch response; `<InlineSessionStream>` subscribes via WS |

**WS-driven cache invalidation** (the bridge between Zustand and TanStack Query):

| Event | Invalidates |
|---|---|
| `session.created`, `session.spawned` | `sessions.list()` |
| `session.titled` | `sessions.list()`, `sessions.detail(sessionId)` |
| `session.auto_distilled` | `drafts.list()`, `notifications.list()` (a draft-review notification is created server-side) |
| `notification.created`, `notification.updated`, `notification.resolved` | `notifications.list()` |
| `drafts.pruned` | `drafts.list()` |
| `skill.loaded`, `skill.load_failed` | `skills.list()` |
| `embedding.indexed`, `embedding.failed` | nothing — surface in console only |
| **WS reconnect** (status: `reconnecting → open`) | `sessions.detail(<every-subscribed-id>)` *and* call `session-stream.hydrateFromDetail()` on refetch — closes the resync gap for events missed during the disconnect |

Everything else (message deltas, tool chips, recall, context compression, expert spend) is **Zustand-only** — TanStack Query never knows about per-turn state. Reasoning: turn-time deltas would thrash any cache they touched, and the cache isn't the right consumer anyway (the consumer is `<MessageList>`, which subscribes to the store directly).

**Query defaults** (set on `QueryClient` construction):

```ts
new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,                       // one retry; further failures surface as ApiError to the caller
      refetchOnWindowFocus: false,    // server has no clock-driven state we'd miss
      staleTime: 30_000,              // 30s default; tighten on a per-key basis when needed
    },
    mutations: { retry: 0 },          // never auto-retry mutations
  },
})
```

---

## 4. Zustand store shape + WS reducer wiring

Four small stores. None of them persist to localStorage except `ui` (theme + tray-open flag). All are created with the standard `create<T>()` pattern; no middleware beyond `immer` for the deeply-nested session-stream slice (optional — flat reducers are fine if `immer` becomes noisy).

### 4.1 `stores/session-stream.ts` — per-session WS-derived state

```ts
export interface SessionStream {
  sessionId: string
  /** Streamed assistant message currently being assembled. Null between turns. */
  activeAssistant: {
    turnId: string
    text: string
    toolChips: Record<string /* toolCallId */, ToolChipState>
  } | null
  /** Completed turns rendered from the session-detail GET; mutated by WS as new
   *  messages stream in. Keyed for stable React reconciliation. */
  turns: Turn[]
  toolCalls: Record<string /* turnId */, ToolChipState[]>
  /** True between `turn.cancel_requested` and `turn.cancelled` — drives the
   *  "Cancelling…" badge state on <CancelButton>. */
  cancelRequested: boolean
  /** Most recent profile-mismatch error from the API (drives the banner above
   *  the composer). Cleared when the user navigates away or the session
   *  successfully accepts a message. */
  profileMismatch: { requiredProfile: string; message: string } | null
  /** Set when `session.awaiting_input` fires for this session. Cleared when
   *  the user posts a non-empty message back. The Chat route uses this to
   *  show an "agent is waiting" badge above the composer when the user is
   *  actually on the awaiting session. */
  awaitingInput: { notificationId: number; question: string } | null
  /** Most recent `recall.injected`, `context.compressed`, `expert.consulted`
   *  meta events — rendered as inline "meta" rows in <MessageList>, capped at
   *  the most recent 50. */
  metaRows: Array<{ id: string; ts: number; text: string; kind: 'info' | 'warn' | 'error' }>
}

interface SessionStreamState {
  byId: Record<string, SessionStream>

  /** Lifecycle */
  ensure(sessionId: string): void                    // idempotent; call when route mounts
  drop(sessionId: string): void                      // call when no consumer left
  hydrateFromDetail(sessionId: string, detail: SessionDetailResponse): void

  /** WS reducer entry point. Branches on event.type. */
  applyEvent(event: AgentEvent): void

  /** Mutation-side helpers for the route */
  setProfileMismatch(sessionId: string, info: SessionStream['profileMismatch']): void
  clearProfileMismatch(sessionId: string): void
}
```

**`applyEvent()` reducer wiring** (the full table — this is the central place to look when adding a new event type):

| Event type | Effect on `SessionStream` |
|---|---|
| `message.user.received` | append a `Turn` row (role: 'user') to `turns` — content comes from the API response of POST messages; if absent, leave a placeholder and let the next session detail refresh fill it |
| `message.assistant.started` | set `activeAssistant = { turnId, text: '', toolChips: {} }` |
| `message.assistant.delta` | `activeAssistant.text += delta` |
| `message.assistant.completed` | move `activeAssistant` into `turns` as a `Turn`; move its `toolChips` into `toolCalls[turnId]`; set `activeAssistant = null` |
| `tool.called` | `activeAssistant.toolChips[toolCallId] = { toolCallId, tool, status: 'pending' }` |
| `tool.completed` | update `toolChips[toolCallId]` → `{ status: 'done', durationMs }` |
| `tool.failed` | update `toolChips[toolCallId]` → `{ status: 'failed', failCode, failMessage }` |
| `tool.result_truncated` | mark the matching chip `truncated: true` |
| `turn.cancel_requested` | `cancelRequested = true` |
| `turn.cancelled` | `cancelRequested = false`; if `activeAssistant`, finalise it into `turns` with whatever text was streamed; append a meta row "Cancelled (soft/hard)" |
| `session.awaiting_input` | `awaitingInput = { notificationId, question }` |
| `recall.injected` | push to `metaRows` (`info`, capped at 50) |
| `context.compressing` / `context.compressed` / `context.compression_failed` / `context.truncated` | push to `metaRows` |
| `tool.result_truncated` | also push a `warn` meta row |
| `skill.loading` / `skill.loaded` / `skill.load_failed` | push to `metaRows` |
| `expert.consulted` / `expert.budget_exceeded` | push to `metaRows` (`info` / `error`) |
| `tool.hook_denied` / `tool.hook_mocked` | push to `metaRows` (`error` / `info`) |
| `session.auto_distilled` / `session.auto_distill_skipped` | push to `metaRows` |

Events not in this table (e.g. `embedding.*`, `drafts.pruned`, every Module-contributed event) are not consumed by `session-stream` — they're invalidation triggers for TanStack Query (see §3) or feed `notifications` / `ws` stores.

### 4.2 `stores/notifications.ts` — global notification state

```ts
interface NotificationsState {
  /** Unresolved attention-needed count — drives the bell badge. */
  unresolvedAttentionCount: number
  /** Most-recent toast queue; entries dropped after 3s by the queue component. */
  toastQueue: Array<{ id: string; notification: Notification; receivedAt: number }>
  /** Source of truth is TanStack Query (notifications.list()). This store
   *  derives `unresolvedAttentionCount` from WS events for instant updates,
   *  then `useNotifications()` reconciles when the list refetches. */
  applyEvent(event: AgentEvent): void
}
```

Reducer wiring:

| Event | Effect |
|---|---|
| `notification.created` (kind: 'attention_needed') | `unresolvedAttentionCount++`; push to `toastQueue` |
| `notification.created` (kind: 'info' / 'error') | push to `toastQueue` only |
| `notification.resolved` (was attention_needed) | `unresolvedAttentionCount = max(0, n - 1)` |
| `notification.updated` (status changed to resolved/dismissed) | `unresolvedAttentionCount = max(0, n - 1)` if it was attention |

`useNotifications()` reconciles the count on every successful refetch — if a refetch returns 3 unresolved attention notifications, the store is forcibly set to 3, regardless of what WS-derived increments said. This guards against missed events on a reconnect.

### 4.3 `stores/ws.ts` — WebSocket lifecycle

```ts
interface WsState {
  status: 'connecting' | 'open' | 'closed' | 'reconnecting'
  reconnectAttempts: number
  /** Sessions the client is currently subscribed to (`?sessionId=` on the WS or
   *  follow-up subscribe messages). Reference-counted internally so two
   *  components subscribing to the same session don't unsubscribe each other. */
  subscribedSessions: Set<string>
  /** Imperative entry point — call once at app root. */
  connect(): void
  subscribe(sessionId: string): void
  unsubscribe(sessionId: string): void
}
```

**The only consumer-facing API is the `useSessionSubscription(sessionId)` hook**, defined in `lib/ws.ts`. It subscribes on mount, unsubscribes on unmount, and ref-counts so `<ChatRoute>` and `<InlineSessionStream>` can both subscribe to the same session without stepping on each other. Components must NOT call `ws.subscribe/unsubscribe` directly — the hook is the single source of truth for who's listening to what. The Chat route and the spawned `<InlineSessionStream>` are the only callers in Phase 1.5.

The WS module (`lib/ws.ts`) dispatches every parsed event to **all three** stores: `session-stream`, `notifications`, and (via §3's WS→cache invalidation table) the `QueryClient`. The dispatch fanout is one function — easy to test, easy to add another consumer.

**Reconnect resync.** When the WS transitions `reconnecting → open`, the client cannot trust its local session-stream state because individual deltas may have been missed during the gap. The `connect()` handler invalidates `sessions.detail(<id>)` for every currently-subscribed session and calls `session-stream.hydrateFromDetail()` on the refetched payload — this rebuilds turns + tool-calls from the authoritative server snapshot and resumes live deltas from there. Notifications use the same pattern (handled by `useNotifications()` refetch in §4.2).

```ts
// lib/ws.ts (sketch)
import { useSessionStreamStore } from '@/stores/session-stream'
import { useNotificationsStore } from '@/stores/notifications'
import { queryClient, queryKeys } from '@/lib/query-client'

function dispatchEvent(event: AgentEvent) {
  useSessionStreamStore.getState().applyEvent(event)
  useNotificationsStore.getState().applyEvent(event)
  invalidateForEvent(event)   // table from §3
}
```

### 4.4 `stores/ui.ts` — UI-only flags

```ts
interface UiState {
  theme: 'light' | 'dark' | 'system'
  setTheme(theme: 'light' | 'dark' | 'system'): void

  trayOpen: boolean
  setTrayOpen(open: boolean): void

  newChatDialogOpen: boolean
  setNewChatDialogOpen(open: boolean): void

  /** Last `?tab=` value remembered for /settings deep-linking. */
  settingsTab: 'profiles' | 'theme' | 'hooks' | 'integrations'
  setSettingsTab(tab: UiState['settingsTab']): void
}
```

Only `theme` is persisted to `localStorage` (key: `agentone:theme`). The other flags reset on reload.

---

## 5. Component prop signatures

The five ADR-0007 module components + the shell + chat components used cross-route. Module-specific content (Phase 2–5) isn't speccable yet; this section pins only the components the Phase 1.5 punch list builds.

### 5.1 Shell components

```ts
// shell/AppShell.tsx — wraps every route
interface AppShellProps { children: React.ReactNode }

// shell/TopBar.tsx — fixed-height (48px) header
// No props — reads health + theme + notification count from stores/hooks directly.

// shell/Sidebar.tsx
// No props — owns SessionList + SidebarNav + NewChatDialog trigger.

// shell/SidebarNav.tsx — feature links above the session list
// No props.

// shell/SessionList.tsx
interface SessionListProps {
  // Empty — pulls from useSessions() + useHealth() (for boot profile comparison).
}

// shell/SessionListRow.tsx
interface SessionListRowProps {
  session: Session
  isActive: boolean              // current route's :sessionId matches
  bootProfile: string            // for the amber-dot mismatch indicator
}

// shell/NotificationTray.tsx
interface NotificationTrayProps {
  open: boolean
  onOpenChange(open: boolean): void
}

// shell/NewChatDialog.tsx
interface NewChatDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
}
```

### 5.2 Chat components

```ts
// routes/chat/ChatRoute.tsx — mounted at /chat and /chat/:sessionId
// No props (reads :sessionId from useParams).

// routes/chat/MessageList.tsx — EXTRACTED so <InlineSessionStream> can reuse
interface MessageListProps {
  sessionId: string
  /** When true, hide the in-flight cancel UI and pin scroll to the bottom of
   *  the embedded container rather than the viewport. <InlineSessionStream>
   *  sets this to true. */
  embedded?: boolean
}

// routes/chat/MessageItem.tsx
interface MessageItemProps {
  turn: Turn
  toolChips: ToolChipState[]
}

// routes/chat/ToolChip.tsx
interface ToolChipProps {
  chip: ToolChipState
}

// routes/chat/Composer.tsx
interface ComposerProps {
  sessionId: string
  disabled: boolean              // true when profile-mismatch banner is up or no session selected
}

// routes/chat/SlashOverlay.tsx
interface SlashOverlayProps {
  open: boolean
  onSelectCommand(name: string): void
}

// routes/chat/CancelButton.tsx
interface CancelButtonProps {
  sessionId: string
  visible: boolean               // mounted only while a turn is in-flight
}

// routes/chat/ProfileMismatchBanner.tsx
interface ProfileMismatchBannerProps {
  requiredProfile: string
}
```

### 5.3 Module components (ADR-0007 M1–M5)

```ts
// components/module/ActionToolbar.tsx (M1)
interface ActionToolbarProps {
  module: string                                          // 'email' | 'projects' | …
  contextId: string                                       // emailId, projectId, etc.
  actions: ModuleAction[]
  errors: ModuleActionsError[]
  /** Called with the spawned session id after a successful dispatch. Caller
   *  decides what to do (typically: open an <InlineSessionStream>). */
  onDispatched(action: string, sessionId: string): void
}

// components/module/InlineSessionStream.tsx (M2)
interface InlineSessionStreamProps {
  sessionId: string
  open: boolean
  onOpenChange(open: boolean): void
  /** Fired when `session.awaiting_input` fires for this session. Caller
   *  typically opens the notification tray or pulses the bell. */
  onAwaitingInput?(question: string, notificationId: number): void
}

// components/module/AskAgentMenu.tsx (M3)
interface AskAgentMenuProps {
  module: string
  tab: string                                              // current detail-page tab
  contextId: string
  /** Pre-filtered to surface ∈ {'ask_agent', 'both'} && tabs includes `tab`. */
  skills: ModuleAction[]
  onDispatched(action: string, sessionId: string): void
}

// components/module/KpiStrip.tsx (M4)
interface KpiPill {
  id: string
  label: string
  count: number
  tone?: 'default' | 'warn' | 'error'
}
interface KpiStripProps {
  pills: KpiPill[]
  activePillId: string | null
  onPillClick(pillId: string): void
}

// components/module/StatusActionButton.tsx (M5)
interface StatusTransition {
  primary: { label: string; onClick(): void; disabled?: boolean }
  secondary: Array<{ label: string; onClick(): void; disabled?: boolean }>
}
interface StatusActionButtonProps {
  status: string
  transitions: Record<string /* status */, StatusTransition>
}

// components/module/ModulePanel.tsx (E1) — the shared master/detail shell
interface ModulePanelProps {
  /** Optional KPI strip slot. */
  kpiStrip?: React.ReactNode
  /** Master list. */
  list: React.ReactNode
  /** Detail pane. Falls back to <empty> when nothing selected. */
  detail: React.ReactNode | null
  emptyState?: React.ReactNode
}
```

**Layout contract for `<ModulePanel>`**: the master list is fixed-width on the left (~360px configurable per module via CSS variable `--module-list-width`); the detail pane fills the rest. Both panes scroll independently. The optional KPI strip sits above both at full-width. URL drives selection: `/<module>` shows list + empty detail; `/<module>/<id>` shows list with the matching row highlighted + populated detail.

### 5.4 Settings components

```ts
// routes/settings/SettingsRoute.tsx
// No props — reads ?tab= from URL.

// routes/settings/ProfilesTab.tsx
// No props — uses useProfiles().

// routes/settings/ProfileEditor.tsx
interface ProfileEditorProps {
  profile: ProfileListEntry | null          // null = create mode
  bootProfile: string                       // for the restart banner
  onSaved(): void
  onCancelled(): void
}
```

The editor uses `react-hook-form` with a `zod` resolver mirroring `CreateProfileRequest`. Server-side validation errors come back as `ApiError` with `details: Array<{ path: string[]; message: string }>` — map `path.join('.')` to `setError(fieldName, { message })`.

---

## 6. Provider mounting order (App.tsx / main.tsx)

```tsx
// main.tsx
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { ThemeProvider } from '@/shell/ThemeProvider'
import { Toaster } from '@/components/ui/sonner'   // shadcn toast
import { queryClient } from '@/lib/query-client'
import { router } from '@/router'
import { connectWebSocket } from '@/lib/ws'
import './styles/globals.css'

connectWebSocket()                            // single global socket, idempotent

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </ThemeProvider>
)
```

**Why this order:** ThemeProvider on the outside so even error fallbacks render in the right colours. QueryClientProvider above the router so route loaders can use TanStack Query. The WS connection lives outside React (it's a singleton in `lib/ws.ts`) — React subscribes to its events via Zustand selectors.

---

## 7. Routing + URL param shapes

`react-router-dom@6` with `createBrowserRouter`. The full route table:

| Route | Component | URL params | Search params |
|---|---|---|---|
| `/` | redirect → `/chat` | — | — |
| `/chat` | `ChatRoute` | — | — |
| `/chat/:sessionId` | `ChatRoute` | `sessionId` | — |
| `/email` | `EmailRoute` | — | filter pill id (e.g. `?filter=unread`) |
| `/email/:emailId` | `EmailRoute` | `emailId` | as above |
| `/projects` | `ProjectsRoute` | — | `?filter=...` |
| `/projects/:projectId` | `ProjectsRoute` | `projectId` | `?tab=tasks` (default), `?tab=emails`, `?tab=proposals`, `?tab=invoices`, `?tab=scope`, `?tab=activity`, etc. |
| `/proposals` | `ProposalsRoute` | — | `?filter=...` |
| `/proposals/:proposalId` | `ProposalsRoute` | `proposalId` | — |
| `/invoicing` | `InvoicingRoute` | — | `?filter=...` |
| `/invoicing/:invoiceId` | `InvoicingRoute` | `invoiceId` | — |
| `/drafts` | `DraftsRoute` | — | — |
| `/skills` | `SkillsRoute` | — | `?skill=<name>` (drawer selection) |
| `/settings` | `SettingsRoute` | — | `?tab=profiles\|theme\|hooks\|integrations` |
| `*` | `NotFound` | — | — |

**Param conventions:**
- All ids in URLs are the storage-level ids — UUID for sessions, slug for projects/proposals/invoices/emails. Never the display number (`number` shown in Projects panel is a separate property).
- `?tab=` always overrides the last-selected tab; no fall-back to the previously chosen one when navigating between projects.
- `?filter=` is module-defined; `<ModulePanel>` doesn't interpret it.

**Deep-link cases the punch list cares about:**
- `/chat/<id>` — open session, subscribe via WS handshake (`?sessionId=<id>`).
- `/settings?tab=profiles` — open Settings on the Profiles tab (used by the new-chat dialog's `Manage profiles…` link).
- `/settings?tab=integrations&qbo=connected|error` — landing after the QBO OAuth callback (Phase 5, but the route shape is reserved here).

---

## 8. Build + dev wiring

- **Dev**: `pnpm web:dev` runs `vite dev` on port `5174` and Fastify on `3737` (the server's default — see `PORT` in [`src/server/config.ts`](../../src/server/config.ts)). Vite is configured with `server.proxy = { '/api': 'http://localhost:3737', '/ws': { target: 'ws://localhost:3737', ws: true } }` so the React app talks to the dev Fastify without CORS plumbing.
- **Build**: `pnpm web:build` emits to `src/web/dist/`. Fastify, when started with `FRONTEND_DIR=./src/web/dist`, serves this as static. SPA fallback: the static handler is configured to serve `index.html` for any unknown path that doesn't start with `/api` or `/ws`.
- **Test**: `pnpm web:test` runs Vitest in jsdom mode. Shared logic in `lib/` is tested without React (faster, no DOM); component tests use `@testing-library/react`. Suites live under `src/web/tests/` or co-located `*.test.tsx`.
- **Lint**: `pnpm web:lint` — ESLint with `@typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks`. Tailwind class sorting via `prettier-plugin-tailwindcss`.
- **Component dev surface**: a route at `/__dev/components` (only mounted when `import.meta.env.DEV`) renders the five module components (M1–M5) + `<ModulePanel>` + `<EmptyState>` against mock data. No Storybook in Phase 1.5 — the surface area doesn't justify the dependency. Revisit if it grows past ~20 components.

---

## 9. Loading + error UI conventions

Pinned so every route doesn't reinvent its skeleton.

- **Loading**: every route wraps its primary content in `<RouteSkeleton>` (lives in `components/shared/`). Variants: `chat` (centred prose-width pulse blocks matching the message column), `master-detail` (two-column shimmer for module routes), `list` (rows for sessions / drafts / skills / commands). The skeleton renders while ANY `useQuery` the route depends on is in its `pending` initial state. Background refetches do NOT re-show the skeleton — TanStack Query's `isFetching && !isLoading` is the trigger to dim, not to replace.
- **Errors**: every route is wrapped in `<RouteErrorBoundary>` (a thin wrapper over React's `<ErrorBoundary>` + `react-error-boundary`). It renders a centred card with the error message, a "Retry" button (calls `queryClient.invalidateQueries()` for the route's keys), and an "Open in console" button (logs the full error). Mount this in the router config, NOT per-route, so deeply-nested throws bubble up cleanly.
- **WS disconnected**: the top bar shows a small amber dot next to the model chip when `ws.status !== 'open'`. Tooltip carries the reconnect attempt count. The chat composer stays enabled (the server still accepts messages over HTTP) but a meta-row appears in `<MessageList>` for the duration: *"Live updates disconnected — reconnecting…"* — cleared on `reconnecting → open`.
- **Mutation errors**: surfaced via toast (sonner), NOT the route's error boundary. The boundary is for unrecoverable query/render failures; a failed POST is a transient state the caller handles in-component.
- **Empty states**: every list route has an `<EmptyState icon title body action?>` variant when its query returns `[]`. Distinct from loading and error.

The four states (loading / loaded-empty / loaded-populated / errored) are mutually exclusive at the route level; the punch list items don't itemise them individually because this section is the convention.

---

## 10. What this spec does NOT pin

- **Module-specific content** (Email list rendering, Projects detail tabs, Proposals split view, Invoicing drift block). Those land in Phases 2–5; the spec defines only the shared shell + the props those routes consume.
- **Internal markup of shadcn primitives.** Use shadcn directly (Button, Sheet, Dialog, AlertDialog, Command, DropdownMenu, Tabs, Tooltip, Toaster); the design system is the shadcn defaults plus Tailwind tweaks.
- **Animation polish.** Sane defaults via shadcn / Tailwind transitions; no Framer Motion unless a specific surface needs it.
- **Sentry / telemetry wiring.** Out of scope for v2.

---

## 11. Cross-references

- Punch list (work items, statuses): [`./phase-1.5-react-punchlist.md`](./phase-1.5-react-punchlist.md)
- Shell ADR (layout, notification pattern): [`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md)
- Module conventions ADR (action surfaces, inline streams): [`../adr/0007-module-panel-conventions.md`](../adr/0007-module-panel-conventions.md)
- Server contract reference (REST/WS shapes): [`../historical/FRONTEND-HANDOFF-2026-05.md`](../historical/FRONTEND-HANDOFF-2026-05.md)
- Business flow + module specs: [`./v2-business-flow.md`](./v2-business-flow.md)
- Server event union (authoritative): [`../../src/core/events.ts`](../../src/core/events.ts)
- Server domain types: [`../../src/core/types.ts`](../../src/core/types.ts)

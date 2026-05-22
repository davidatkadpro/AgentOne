# V2 — Business Flow Modules

Plan for the next major phase after the v1 push (M14–M19) landed. V2 turns
AgentOne from "a chat-driven local agent with memory" into "a desk-side
operations app for a design/drafting practice" — email triage, project
management, scope/proposal generation, and QBO-integrated invoicing — while
preserving the agent as a first-class collaborator rather than the only
interface.

Last reviewed: 2026-05-22 (planning session producing this doc).

Companion documents:
- [`../adr/0004-modules-as-second-extensibility-primitive.md`](../adr/0004-modules-as-second-extensibility-primitive.md)
- [`../adr/0005-non-chat-session-activation.md`](../adr/0005-non-chat-session-activation.md)
- [`../../CONTEXT.md`](../../CONTEXT.md) — domain language and relationships
- [`./v1-remaining.md`](./v1-remaining.md) — predecessor doc

---

## What V2 adds, at a glance

- **Module** — a new architectural primitive alongside Skill. Owns tables,
  events, a typed service, and ships the Skills the agent uses to operate on
  its state. Drop a folder under `modules/` to add one.
- **Open service surface** — Module services are callable by Skills, HTTP
  routes, hooks, schedulers, and other modules. The agent is one client of the
  service layer, not its only client.
- **Spawned Session + `awaiting_input` + Notification** — three coordinated
  additions that let work start outside chat (an email-view button, an event,
  a scheduled trigger) and surface to the user when the agent needs attention.
- **Four domain modules**: `projects`, `email`, `proposals`, `invoicing`.

The agent's role does not shrink — it gains new domains to reason about and
new ways to be activated. Chat remains a first-class interface; the new UI
panels and HTTP routes are siblings, not replacements.

---

## Architectural primitives (Phase 1)

### Module

```
modules/<name>/
├── MODULE.md              # frontmatter manifest + prose for the agent's prompt
├── schema/
│   └── 0001_init.sql      # versioned migrations applied in order
├── src/
│   ├── service.ts         # exports createService(deps) → Service singleton
│   ├── events.ts          # exports eventTypes (discriminated union additions)
│   └── index.ts           # exports { manifest, createService, eventTypes }
└── skills/
    └── <skill-name>/SKILL.md   # Skills the agent uses to drive this module
```

`MODULE.md` frontmatter (locked, minimal):

```yaml
---
name: projects
description: Project, phase, task, and subtask records with status and dependencies.
version: 1
events: [project.created, project.updated, task.created, task.completed, ...]
depends_on: []           # other modules whose services this one calls
spawnable_profiles: []   # agent profiles this module is allowed to spawn (empty = none)
---
```

Schema version is **derived from the filesystem** — the highest migration number
under `schema/` is canonical. No `schema_version` field.

Boot lifecycle: filesystem scan → topological sort by `depends_on` → apply
migrations tracked in a `schema_migrations` table → instantiate via
`createService({ db, eventBus, storage, otherModules })` → register in the
`ModuleRegistry` injected into `ToolContext` and HTTP request context. A broken
migration freezes that module at its last good version and emits
`module.degraded` — other modules and the chat UI still boot.

### Spawned Session, Awaiting Input, Notification

`sessions` schema additions:

```sql
ALTER TABLE sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE sessions ADD COLUMN spawned_by TEXT NULL;
```

`state` values: `'active' | 'awaiting_input' | 'archived'`.

New Core Tool: `request_user_input(question, options?)`. Emits
`session.awaiting_input`, sets state, ends the turn. Resumes on the next user
message.

New table:

```sql
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,       -- 'info' | 'attention_needed' | 'error'
  title TEXT NOT NULL,
  body TEXT,
  session_id TEXT,
  module TEXT,
  payload_json TEXT,
  status TEXT NOT NULL,     -- 'unread' | 'read' | 'resolved' | 'dismissed'
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
```

New HTTP routes: `GET /api/notifications`, `PATCH /api/notifications/:id`.
New WebSocket events: `notification.created`, `notification.updated`,
`notification.resolved`.

### Audit Log

New table written by Module services on every mutation. Immutable, complete
record of "what happened to the system." Distinct from the event log
(observational, may drop high-frequency events) and from notifications (UI
signals, dismissable).

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,    -- 'agent' | 'http' | 'hook' | 'scheduler' | 'module'
  actor_id TEXT,               -- session_id, route path, hook name, etc.
  module TEXT NOT NULL,
  action TEXT NOT NULL,        -- e.g. 'project.create', 'invoice.push'
  target_id TEXT,              -- the affected entity id
  details_json TEXT
);
```

### Scheduled Trigger

Modules can register cron-like tasks at boot:

```ts
scheduler.register('invoicing.pollQbo', { intervalMs: 15 * 60 * 1000 }, async () => {
  await invoicing.pollQbo()
})
```

Extracted from the existing `AutoDistillScheduler` pattern; nothing user-facing
changes.

---

## Domain modules

### `modules/projects/`

The central module — every other module references projects.

**Entities**: `project`, `phase`, `task` (self-referential for subtasks),
`task_dependency`. Uniform status enum (`pending | active | blocked |
completed | cancelled`) across project/phase/task. `metadata_json` column on
every row for ad-hoc extensions.

**Key column**: `project.number` — operator-configured format (default `YY###`,
e.g. `24001`). Replaces the date-prefixed folder convention from v1.

**Folder convention**:
```
projects/
  24001 - Riverside Reno/      ← <number> - <slug>
    in/
      241108 - rfi from owner/  ← email-filed subfolders stay dated
    drafts/
```

`folder_path` column on `project` records the relative path; folder is created
eagerly at project creation.

**Extension model** — three rings:
1. `metadata_json` — quick field additions, no migration.
2. Companion module (e.g. `modules/aec-projects/`) — declares
   `depends_on: [projects]`, adds its own tables referencing project IDs,
   subscribes to events.
3. Replacement module — interface-compatible replacement for the whole
   `Projects` service; rare but supported.

**Skills**: `create-project`, `list-projects`, `add-task`, `add-phase`,
`update-status`, `mark-complete`, `set-dependency`.

**Events**: `project.created`, `project.updated`, `project.completed`,
`phase.created`, `phase.completed`, `task.created`, `task.updated`,
`task.completed`, `task.blocked`.

### `modules/email/`

A light email triage surface. **Not** a mail client replacement.

**Connector**: an `EmailSource` interface with two implementations —
`GraphEmailSource` (Microsoft Graph, production default) and
`MaildirEmailSource` (local `.eml` folder, dev/offline fallback). Narrow
surface: list / get / mark / move. No outbound mail in v2.

**Local table**: `email` — index of known-to-AgentOne messages, *not* a mirror
of the mailbox. Bodies and attachments live in the source until the email is
filed to a project.

**Action dispatch**: one generic route handles every action.

```
POST /api/email/actions
{
  emailId: "abc123",
  action: "scope-extractor",        # skill name under modules/email/skills/
  args: { suggestedProject: null }  # optional
}
```

The handler loads the email, looks up the Skill at
`modules/email/skills/<action>/SKILL.md`, reads its `default_profile` and
`prompt_template` from frontmatter, renders the seed message, and calls
`Orchestrator.spawnSession(...)`. Adding a new action = drop a folder. No
route changes.

**Initial actions** (each is a Skill folder under `modules/email/skills/`):
- `file-to-project` — write summary + attachments into
  `projects/<n>/in/<date> - <slug>/`. Attempt to match a project; if
  ambiguous, call `request_user_input` with candidates.
- `create-new-project` — create a new Project, then file the email into it.
- `scope-extractor` — write a structured `scope.md` (frontmatter + prose) into
  the project's `in/` folder. May call `request_user_input` for clarifications.

**Skills inside a spawned email-action session** see additional ToolContext
fields: `email.read(id)`, `email.fetchAttachment(id, name)`,
`email.fileToProject(emailId, projectId)`.

**Events**: `email.received`, `email.filed`, `email.action_started`,
`email.action_completed`.

### `modules/proposals/`

Estimates, proposals, and rendering — one module covering all three because
they have one user-facing artifact (the proposal) and no consumers in between.

**Entities**: `estimate`, `estimate_line`, `proposal`. Three pricing kinds
(`fixed | time_and_materials | unit`) all expressed in the same line-item
shape; the kind is a *rendering hint*, not a schema branch.

**Scope is a markdown Document, not a row.** Output of the `scope-extractor`
Email skill lives at `projects/<n>/in/<date>/scope.md` with structured
frontmatter (operator-defined fields like `square_footage`, `phases`,
`exclusions`). The Estimate has a `scope_file_path` pointer.

**Templates** are layered:
- `modules/proposals/templates/<name>/` — defaults shipped with the module.
- `drafts/_templates/proposals/<name>/` — operator overrides; takes precedence.

A template is a folder of `template.md` (Mustache placeholders), optional
`style.css`, and `assets/`. Drop-a-folder ergonomic.

**Rendering pipeline**: Mustache fills the template → markdown is always
produced and saved → optional Pandoc step produces PDF/docx. If Pandoc isn't
installed, the markdown-only path still works; PDF/docx skills return
`RESOURCE_UNAVAILABLE`.

**Skills**: `build-estimate`, `revise-estimate`, `generate-proposal`,
`list-proposals`.

**Events**: `estimate.created`, `estimate.updated`, `estimate.accepted`,
`estimate.rejected`, `proposal.created`, `proposal.issued`,
`proposal.superseded`.

### `modules/invoicing/`

Local invoices/payments + QBO sync + budget tracking. The heaviest module
because of QBO integration.

**Entities**: `invoice`, `invoice_line`, `payment`, `qbo_connection`.

**Budget is a SQL view**, not a table:

```sql
CREATE VIEW project_budget AS
SELECT
  p.id AS project_id,
  COALESCE(... json_extract or accepted-proposal total ...) AS budget_total,
  COALESCE((SELECT SUM(total)        FROM invoice WHERE project_id = p.id AND status != 'void'), 0) AS invoiced_total,
  COALESCE((SELECT SUM(amount_paid)  FROM invoice WHERE project_id = p.id AND status != 'void'), 0) AS paid_total
FROM project p;
```

No cache invalidation; always reflects current state.

**Invoice numbering is local-owned** — `<project-number>-<seq>` like
`24001-01`. QBO's own doc number is recorded as informational.

**QBO sync model**:
- **Push**: `invoicing.pushInvoice(id)` POSTs to QBO; updates `qbo_id`,
  `sync_status='synced'`, `last_synced_at`. Triggered explicitly by Skill or
  HTTP route.
- **Pull**: scheduled poller every 15 minutes (configurable). For each
  changed invoice in QBO since `last_synced_at`: insert / no-op / update /
  flag as `'drift'`. Drift surfaces a `attention_needed` notification.
- **Reconcile**: `reconcile-drift` Skill — operator-driven flow that picks a
  side (local or QBO) and applies the fix.
- **Auth**: OAuth2 PKCE; tokens stored encrypted in `qbo_connection`. Windows
  DPAPI when available; operator-provided key from `.env` as fallback.

**Single-company only** in v2. Multi-company QBO is a major schema change
(every invoice gets a realm_id FK); deferred.

**Time tracking deferred** to a future `modules/time-tracking/` module. AEC
fixed-fee + milestone billing does not require it; T&M operators write Skills
in a follow-up.

**Skills**: `create-invoice`, `sync-to-qbo`, `record-payment`,
`budget-summary`, `reconcile-drift`.

**Events**: `invoice.created`, `invoice.issued`, `payment.recorded`,
`qbo.invoice_pushed`, `qbo.invoice_pulled`, `qbo.drift_detected`,
`qbo.sync_failed`.

---

## Build order

Vertical slices — each phase ends with a demoable, useful slice. Estimates are
best-case for a focused contributor; multiply by 1.5–2× for alongside-other-work.

### Phase 1 — Foundation (backend only, ~1 week)
- Module primitive: discovery, `MODULE.md` parser, migration runner,
  `ModuleRegistry`, service injection into `ToolContext` and HTTP context.
- New schema: `notifications`, `audit_log`, `sessions.state`,
  `sessions.spawned_by`.
- New Core Tool: `request_user_input`.
- New endpoints: `GET /api/notifications`, `PATCH /api/notifications/:id`,
  `POST /api/sessions` accepting `seed`.
- Scheduler primitive extracted from `AutoDistillScheduler`.
- WebSocket: emit `notification.*` events.
- No domain modules yet — this is plumbing.

### → Frontend grill session ←

The operator runs a separate grill session focused on frontend architecture
(layout, panel-vs-route, state management, chat-vs-panel interplay) before
Phase 1.5 begins.

### Phase 1.5 — React parity rewrite (~1 week)
- React + the chosen stack. Reproduces today's vanilla-JS UX exactly: session
  list, chat view, slash autocomplete, event stream rendering. **No new
  features.**
- Notification tray scaffolding wired but empty.
- Locks the frontend platform before any module-touching frontend work.

### Phase 2 — Projects (backend + UI, ~1 week)
- `modules/projects/` complete: schema, service, skills, HTTP routes.
- Projects panel: list, detail view (phases/tasks tree), create-project form.
- "Select a project" UI used by later modules' `request_user_input` flow.

### Phase 3 — Email + file-to-project (~1–2 weeks)
- `modules/email/` with `MaildirEmailSource` first (defer Graph OAuth).
- Email view: inbox listing, message preview, action buttons.
- `file-to-project` skill end-to-end: button → spawned session → ambiguous
  match → `request_user_input` → user picks project → file written →
  notification clears.
- `create-new-project` skill (trivial after file-to-project works).
- `GraphEmailSource` as a sub-phase once OAuth is set up.

### Phase 4 — Scope extractor + Proposals (~1–2 weeks)
- `scope-extractor` Email skill (writes `scope.md`).
- `modules/proposals/`: schema, service, `build-estimate` skill, markdown-only
  proposal output.
- Proposals panel: list, detail view, "generate proposal" button.
- Pandoc renderer as optional polish.

### Phase 5 — Invoicing + QBO (~2–3 weeks, heaviest)
- Local-only first: schema, `create-invoice`, `record-payment`,
  `budget-summary` skills, Invoicing panel.
- QBO OAuth flow + push (most useful direction first).
- QBO pull poller + drift detection + `reconcile-drift` skill.
- Multi-company stays deferred.

---

## Things explicitly NOT in V2

- **Sub-agents (`spawn_agent`).** Same deferral as v1 — `spawned sessions` are
  not sub-agents; they're sessions spawned by HTTP/Module callers and still
  controlled by the orchestrator.
- **Worker-thread isolation for module code.** Modules are trusted, in-process —
  same trust model as Skills.
- **Multi-company QBO.** Defers a meaningful schema change. Single-realm
  `qbo_connection` row.
- **Time tracking.** A future `modules/time-tracking/` module; not load-bearing
  for AEC fixed-fee + milestone billing.
- **Outbound email.** `EmailSource` stays read-only in v2. No `send_reply`,
  no `send_proposal`. Operators send proposals manually for now.
- **Webhook ingestion** (e.g. QBO event webhooks). Local app, no public URL —
  poll instead.
- **Multi-user concurrency.** Same v1 line.
- **CRM module.** `project.client` stays free text. A future CRM module will
  add Contacts/Companies and migrate the field.
- **Approval workflows** as first-class entities (`pending_review`,
  `awaiting_signoff`, etc.). Notification + Skills cover the same UX.
- **Automatic conflict resolution for QBO drift.** Operator-driven via
  `reconcile-drift`.

---

## Cross-references

- PRD: [`../PRD.md`](../PRD.md)
- ADR-0004: [`../adr/0004-modules-as-second-extensibility-primitive.md`](../adr/0004-modules-as-second-extensibility-primitive.md)
- ADR-0005: [`../adr/0005-non-chat-session-activation.md`](../adr/0005-non-chat-session-activation.md)
- CONTEXT.md: [`../../CONTEXT.md`](../../CONTEXT.md)
- V1 predecessor doc: [`./v1-remaining.md`](./v1-remaining.md)

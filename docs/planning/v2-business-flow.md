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
  project_id TEXT,             -- denormalised for the project Activity tab (nullable)
  details_json TEXT
);

CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX audit_log_project_idx ON audit_log (project_id, ts DESC) WHERE project_id IS NOT NULL;
CREATE INDEX audit_log_module_action_idx ON audit_log (module, action, ts DESC);
```

**`project_id` is an explicit nullable column**, not a generated column over `details_json`. Reasoning: the project-detail Activity tab is the primary consumer of this index, the column is cheap (~36 bytes when populated), and an explicit field forces module authors to make the project association deliberate at the point of writing the audit row rather than relying on a JSON-key convention. The partial index keeps non-project-scoped audits (settings edits, profile changes, agent-only operations) out of the index entirely. The Audit service exposes `audit.write({ module, action, actor, targetId, projectId?, details? })`; modules whose entities carry `project_id` MUST pass it through. For audits triggered indirectly (e.g. an invoice push that affects an invoice whose proposal references a project), the calling service resolves the project id from the entity chain and passes it explicitly — no automatic JSON extraction.

Activity-tab query shape: `SELECT id, ts, actor_kind, actor_id, module, action, target_id, details_json FROM audit_log WHERE project_id = ? ORDER BY ts DESC LIMIT 50 OFFSET ?`. The Activity tab in v2 renders audit rows only; bus events (the observational event log) are not folded into this view in v2 — adding them would require a parallel `events.project_id` denormalisation, deferred until the audit-only view proves insufficient.

### Scheduled Trigger

Modules can register cron-like tasks at boot:

```ts
scheduler.register('invoicing.pollQbo', { intervalMs: 15 * 60 * 1000 }, async () => {
  await invoicing.pollQbo()
})
```

Extracted from the existing `AutoDistillScheduler` pattern; nothing user-facing
changes.

### Action discovery & dispatch

The convention from [ADR-0007](../adr/0007-module-panel-conventions.md) — drop a Skill folder, get a UI surface — needs a uniform server contract every module honours. Pinned here so each module's section can refer back to it instead of restating the shape.

**SKILL.md frontmatter additions (optional, opt-in per Skill):**

```yaml
---
name: file-to-project                 # existing — kebab-case skill id
description: File this email into ... # existing — surfaced as button tooltip
label: File to project                # NEW — short button label; defaults to title-cased name
icon: folder-input                    # NEW — lucide icon name; optional
default_profile: ops                  # NEW — agent profile to spawn the session under
prompt_template: |                    # NEW — Mustache seed for spawnSession (renders with action args)
  File this email into the right project.
  Email: {{email.id}} — "{{email.subject}}"
requires_confirmation: false          # NEW — UI shows an AlertDialog before dispatch when true
surface: action                       # NEW — 'action' | 'ask_agent' | 'both'; default 'ask_agent' for module-scoped Skills
tabs: [emails, scope]                 # NEW — for 'ask_agent' surface, which detail-page tabs this applies to
---
```

The existing fields (`tools`, `allowed-tools`, `slash_command`, `docs`, `version`) keep their current semantics. The seven new fields extend [`SkillFrontmatterSchema`](../../src/skills/frontmatter.ts) with all-optional Zod fields so legacy Skills continue to load unchanged.

**`GET /api/<module>/actions`** — discovery endpoint, served by a shared loader registered once per module:

```ts
// Response shape
{
  actions: Array<{
    name: string                      // Skill's `name` (kebab-case, unique within module)
    label: string                     // resolved (`label` ?? title-cased `name`)
    description: string               // Skill's `description`
    icon: string | null               // `icon` if present
    defaultProfile: string | null     // `default_profile` if present
    requiresConfirmation: boolean     // `requires_confirmation` ?? false
    surface: 'action' | 'ask_agent' | 'both'  // default 'ask_agent'
    tabs: string[]                    // `tabs` ?? []
  }>,
  errors: Array<{
    skill: string                     // folder name relative to modules/<module>/skills/
    error: string                     // human-readable parse/validation error
  }>
}
```

Broken Skills (invalid frontmatter, missing handler) surface in `errors[]` and **do not** appear in `actions[]`, matching the existing `GET /api/profiles` `ok: false` pattern. The frontend's `<ActionToolbar>` renders disabled entries from `errors[]` with the error in a tooltip so the operator sees something is wrong without crashing the panel.

**`POST /api/<module>/actions`** — dispatch endpoint, one per module, generic over the module's action vocabulary:

```ts
// Request
{
  action: string                       // must match a `name` from the discovery response
  contextId: string                    // module-defined: emailId for /email, projectId for /projects, etc.
  args?: Record<string, unknown>       // optional; passed to the Mustache template + ToolContext
}

// Response (success)
{
  sessionId: string                    // spawned session id; client subscribes immediately
  action: string                       // echoed for client correlation
}

// Response (failure)
// 404 — unknown action name
// 422 — args failed action's optional Zod schema (if Skill declared one)
// 409 — module-specific guard tripped (e.g. email already filed, project locked)
```

The dispatch handler is implemented once per module (it knows the `contextId` shape and the module-specific seed-context to inject) and shares a small helper that renders `prompt_template` against `{ ...args, contextId, contextEntity }` and calls `Orchestrator.spawnSession({ profile: defaultProfile, seed, allowedSkills: [<action>] })`. Modules without a contextual surface (event-only modules) omit `POST /api/<module>/actions` entirely.

**Default values and back-compat:**
- A Skill with no new frontmatter fields gets `label: titleCase(name)`, `surface: 'ask_agent'`, `requiresConfirmation: false`, `tabs: []`, and everything else `null`. Module authors only override what differs from the defaults.
- Skills under `skills/` (top-level, not module-scoped) are unaffected — `/api/<module>/actions` only scans `modules/<module>/skills/`. Top-level Skills remain the agent-loaded vocabulary, not module action surfaces.
- The frontend treats `surface: 'ask_agent'` as the "context-menu only" default — those Skills appear in `<AskAgentMenu>` filtered by `tabs`, not in `<ActionToolbar>`. `surface: 'action'` makes a Skill visible in `<ActionToolbar>`. `surface: 'both'` puts it in both.

**Caching:** the discovery loader caches per-module results until a file mtime under `modules/<module>/skills/` changes (or until process restart, if mtime tracking proves flaky). The cache is invalidated when the Module emits a `module.reloaded` event (Phase 1 plumbing) so a freshly-dropped Skill folder shows up without a restart.

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

**Frontend panel** (decided in the 2026-05-23 grill; complements
[`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md)
and inherits its uniform master/detail shell):

- **List `/projects`**: dense rows — `number`, `name + client` (2-line cell),
  `status` badge, inline budget mini-bar (% invoiced of budget, sourced from
  the `project_budget` SQL view), last-activity timestamp. Default filter
  `status in (pending, active, blocked)` with a "Show completed" toggle.
  Sort default: last activity desc. Search by number or name. KPI strip
  above the list with clickable count pills: Active · Blocked · Awaiting
  invoice · Overdue.
- **Create `+ New project`**: modal dialog. Fields: `number` (server
  auto-suggests next `YY###`, editable), `name`, `client?`, `description?`,
  `phase template` dropdown defaulting to `Empty` with an `AEC standard
  (SD/DD/CD/CA)` option. Future templates live under
  `drafts/_templates/projects/<name>/`. Folder created eagerly on submit;
  redirect to `/projects/:id`.
- **Detail `/projects/:id` is the hub** for all cross-module data tied to
  the project. Header strip: `number · name · client · status` badge ·
  budget rollup chip · `open folder` link · `Open in chat with project
  context` link. Below the strip, **eight tabs** in this order:
  1. **Tasks** — phase/task tree (always-visible main content).
  2. **Scope** — renders `projects/<n>/in/<date>/scope.md` as markdown.
  3. **Emails** — list of emails filed to `projects/<n>/in/` via the email module.
  4. **Files** — read-only folder browser for `projects/<n>/in/` and siblings; `open folder` link to OS.
  5. **Proposals** — list of estimates + proposals targeting this project.
  6. **Invoices** — invoices + payments + drift status.
  7. **Drafts** — drafts in `projects/<n>/drafts/` plus global `wiki/drafts/` tagged with this project.
  8. **Activity** — timeline of `audit_log` entries + relevant events for this project.
  Each tab is lazy-loaded via its owning module's GET endpoint; tabs that
  don't apply (no proposals yet, no invoices yet) render an empty state
  rather than being hidden.
- **Tasks tab — phase/task tree**: expandable rows. Phases at top level,
  tasks under phases, subtasks under tasks (self-referential `task` rows).
  **Phases are mandatory** — `task.phase_id` is `NOT NULL`. If a task is
  added before any phase exists, the system auto-creates a renameable
  `Uncategorized` phase. Inline edit: click title to rename; click status
  badge to open an enum popover. Add buttons: `+ Phase` at root, `+ Task`
  per phase, `+ Subtask` inline on a task. Dependencies show as a chip on
  the row (`blocked on Task #14`); a `Dependencies` link opens a popover
  for editing. Drag-to-reorder/reparent is deferred to a polish pass.
- **Task row click → right-edge `Sheet`**, deep-linkable via `?task=<id>`
  on the URL. Sheet body: description (markdown), status, dependencies
  picker, subtasks list, attachments (files referenced from the task body).
  Tree stays visible behind the Sheet.
- **Agent integration**: each tab has an `Ask agent ▾` menu exposing
  context-aware skills — e.g. on **Tasks**: "Break down this phase into
  tasks", "Summarize what's blocked"; on **Scope**: "Generate estimate
  from scope"; on **Emails**: "Draft a reply to the most recent". Each
  menu item spawns a session via `seed.initialMessage` with the project
  (and tab-specific) context pre-populated. The session streams in chat;
  any `request_user_input` calls surface via the notification tray (per
  ADR-0006). The header-strip `Open in chat with project context` link is
  the freeform escape hatch.
- **Status enum colour map**: `pending` (slate), `active` (emerald),
  `blocked` (amber), `completed` (zinc with strikethrough), `cancelled`
  (zinc, muted). Same map used everywhere status appears.

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

**Frontend panel** (decided in the 2026-05-23 grill; complements
[`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md)
and inherits its uniform master/detail shell):

- **List `/email`**: **Inbox-only — no folder navigator**. The `move`
  capability in EmailSource exists so AgentOne can file emails away to
  projects, not for the user to browse `Sent` / `Trash` / `Drafts`. Filed
  emails surface contextually in the project's **Emails** tab. This keeps
  the panel a triage surface, not a mail client.
- **Row design**: compact 2-line. Line 1 — sender (bold if unread) and
  date right-aligned. Line 2 — subject (bold if unread) and snippet
  preview. Right edge — `📎` for attachments, `→ 24001` chip for
  filed-status (clickable; routes to `/projects/24001` with the
  **Emails** tab focused). Filter pills above the list: Unread · Filed ·
  Has attachments. Search filters client-side on subject + sender +
  snippet (full-body search is deferred because the local `email` table
  is an index, not a body mirror).
- **Sync**: server-driven. The EmailSource adapter (Graph poller or
  Maildir fs-watcher) emits `email.received` on the WS bus; the list
  invalidates via TanStack Query and refetches. A manual **Refresh**
  button in the list header hits a new `POST /api/email/poll` to force a
  source check (useful when the user knows an email just arrived).
  **No client polling** — adheres to the ADR-0006 rule.
- **Detail `/email/:id`**: top toolbar with subject + sender + date,
  then an **action toolbar** rendering buttons dynamically from `GET
  /api/email/actions` (see below), then the rendered body (sanitized
  HTML via DOMPurify in a constrained container, plain-text fallback for
  non-HTML messages), then the attachments list (download links via
  `GET /api/email/:id/attachments/:name`; no inline preview in v2).
  Opening a message auto-marks it read; a `Mark unread` button reverts.
- **Action discovery — new endpoint `GET /api/email/actions`** that
  scans `modules/email/skills/` and returns
  `{ name, label, description, icon?, defaultProfile, requiresConfirmation? }`
  per Skill, derived from SKILL.md frontmatter. Frontend renders the
  primary actions as named buttons and overflows the rest into a `▾ More
  actions` menu. **Drop a folder under `modules/email/skills/` and it
  appears in the toolbar — no frontend change required.** Actions with
  `requiresConfirmation: true` show a shadcn `AlertDialog` before
  spawning the session.
- **Inline session stream on the detail page**: after clicking an
  action, a collapsible block under the toolbar streams the spawned
  session live (assistant deltas + tool chips, same renderer as the
  Chat route). `request_user_input` calls still surface via the
  notification tray (per ADR-0006); a banner inside the inline stream
  links to it. An `Open in full chat` link escapes to `/chat/<sessionId>`
  for freeform follow-up.
- **Row-level action state**: each list row reflects
  `email.action_started` → `email.action_completed` as a small chip
  (`▶ filing…` → `✓ filed to 24001` or `✗ failed`), so the user can see
  status when scrolling the list away from the detail page.
- **Single-message actions only in v2** — no multi-select / bulk
  operations. Deferred to v2.x. Skill authors can implement batched
  flows inside a single session if needed.
- **New API endpoints required**: `GET /api/email/actions` (discovery),
  `POST /api/email/poll` (manual refresh),
  `GET /api/email/:id/attachments/:name` (attachment download). The
  existing `POST /api/email/actions` from the action-dispatch design
  is unchanged.

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

**Frontend panel** (decided in the 2026-05-23 grill; complements
[`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md)
and inherits its uniform master/detail shell):

- **List `/proposals` is a mixed rolling-artifact stream.** The schema
  keeps `estimate` and `proposal` separate, but the UI flattens them
  into one row-per-artifact with a status that reads as one continuous
  workflow: `Estimate · draft` → `Estimate · ready` → `Proposal ·
  issued` → `Proposal · accepted | rejected | superseded`. A row with
  no linked proposal renders as the estimate; the same row shifts
  identity to "proposal" when issued. Filter pills above the list
  match the status enum. Row columns: artifact reference (estimate id
  or proposal number), project (`24001 Riverside reno`), status badge,
  total $, last activity, source (`from scope.md` / `manual`). KPI strip:
  Drafts (N) · Issued awaiting response (N) · Accepted this month (N).
- **Detail `/proposals/:id` is a 50/50 split view.** Left pane is the
  **estimate editor**: header strip (project link, version, source
  scope link if any) + line-items table (columns: kind dropdown
  [fixed/T&M/unit], description, qty, unit, unit price, line total),
  inline-edit everything, `+ Line` button at the bottom, totals row.
  Right pane is the **rendered preview** — markdown via the existing
  `react-markdown` stack, live-updates on estimate save or on a
  `Regenerate` toolbar button (Mustache re-fill against the chosen
  template). Top toolbar: a **contextual primary action button** that
  reads the current status (`Mark ready` → `Issue proposal` → `Mark
  accepted` / `Mark rejected`), then an overflow `▾ More` menu with
  `Revise`, `Supersede`, `Download ▾` (markdown always; PDF / docx
  visible only when `GET /api/health` reports Pandoc available).
- **Generation flow — `+ New proposal`**: shadcn `Dialog` with a
  **template dropdown at the top** (lists templates from both
  `modules/proposals/templates/` and `drafts/_templates/proposals/`,
  each tagged `module` or `override`; override wins when names collide)
  and **two tabs below**: **Build from scope** (default) lets the
  operator pick a project, choose one of its `scope.md` documents, and
  hit Generate — spawns a `build-estimate` session via the existing
  spawn-session machinery, which streams inline on the resulting
  `/proposals/:id` page (same pattern as the Email module's inline
  session block). **Start blank** picks a project, creates an empty
  estimate row, and routes to `/proposals/:id` for manual line-item
  entry. `request_user_input` calls during the agent flow surface in
  the notification tray per ADR-0006.
- **Revisions never auto-supersede.** `Revise` creates a new draft
  estimate that points back to the original (`previous_estimate_id`).
  The original estimate and any linked proposal stay in whatever state
  they were in until the operator explicitly hits `Supersede` on the
  old proposal (typically after issuing the revised one). This avoids
  surprise state changes; the trade-off is one extra click per
  revise-then-issue cycle.
- **Status history**: not a separate tab in the split view. A `History`
  link in the overflow menu opens a popover with the chronological
  audit of estimate / proposal events for the artifact chain
  (including superseded predecessors). Pulled from `audit_log` and the
  `proposal.*` / `estimate.*` event log.
- **Agent integration** (per-tab pattern adopted from the Projects
  panel): `Ask agent ▾` menu on the detail toolbar with skills like
  `Revise to total of $X`, `Draft cover letter`, `Re-extract from
  scope`. Each spawns a session with the artifact + scope as seed
  context.
- **Project-scoped view**: the project detail's **Proposals** tab is
  the same mixed list, filtered to that project. `+ New` from inside
  the tab pre-selects the project in the generation modal.

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

**Frontend panel** (decided in the 2026-05-23 grill; complements
[`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md)
and inherits its uniform master/detail shell):

- **List `/invoicing`** is **invoices-only**. Rows: invoice number
  (`<project-number>-<seq>`), project (`24001 Riverside reno` —
  clickable to `/projects/24001`), local status badge
  (Draft / Issued / Partially paid / Paid / Void), QBO sync badge
  (synced / pending / drift / failed), total, balance, last activity.
  Status filter pills above the list. **KPI strip** with clickable
  count pills: `Outstanding $` · `Overdue $` · `Drift (N)` ·
  `Sync-failed (N)` — each pill applies the corresponding filter.
  Payments are sub-objects of invoices (no `/payments` route); budgets
  live on the project detail's **Invoices** tab and as rollups in the
  project header.
- **QBO connection status banner** appears at the top of `/invoicing`
  whenever `qbo_connection` is missing or its tokens are expired. The
  banner deep-links to **Settings → Integrations → QuickBooks Online**,
  which is the canonical home for OAuth setup. Disconnected state
  doesn't block local invoicing; it only gates push/pull and surfaces
  warnings when those are attempted.
- **Invoice detail `/invoicing/:id`** is a **single-pane sectioned
  layout** (not split-view — QBO is the customer-facing render, so a
  live markdown preview earns less of its keep than for proposals):
  1. **Header strip** — number, project link, local status badge,
     sync badge, totals (subtotal, tax, total, balance), contextual
     primary action button (`Issue` → `Mark paid` etc.), and an
     overflow `▾ More` menu carrying `Download ▾`, `History`,
     `Supersede`, `Void`.
  2. **Line items** — editable table identical in shape to proposals
     (kind / description / qty / unit / unit price / line total),
     inline edit, `+ Line` button.
  3. **Payments applied** — list of `payment` rows. `+ Record
     payment` opens a `Dialog` collecting amount, date, method,
     reference, notes; saving emits `payment.recorded`.
  4. **Sync section** — synced timestamp, `qbo_id` (if any), manual
     `Push to QBO` button (single explicit action per ADR-0006's
     non-polling spirit), `Pull from QBO` button. When `sync_status =
     'drift'`, this section expands into a **drift block** (see next).
  5. *(Optional rows)* warnings (e.g. "Pushed to QBO but recipient
     email not set"), notes.
- **Drift reconciliation** is **UI-first, agent-as-escape**. The
  drift block renders a side-by-side diff: local fields on the left,
  QBO fields on the right, with field-level highlights for divergent
  values. Primary buttons: `Keep local (push)` (overwrites QBO),
  `Accept QBO (pull)` (overwrites local), `Custom merge` (opens a
  per-field selector). A `Use agent ▸` link spawns the
  `reconcile-drift` Skill for cases where the operator wants the
  agent's reasoning — same inline-stream pattern as the Email panel,
  with `request_user_input` surfacing in the notification tray.
- **Create flow `+ New invoice`** is a modal with two tabs:
  - **From proposal** (default when the chosen project has accepted
    proposals): pick project → pick accepted proposal → draft
    pre-populated from the proposal's estimate line items. Server
    auto-suggests the next invoice number (`<project-number>-<seq>`).
  - **Blank**: pick project → empty draft.
  Milestone billing (AEC fixed-fee + phase-based billing) is **not** a
  v2 modal tab — it depends on phase data the schema doesn't ship yet;
  handle later via a dedicated `from-milestone` Skill that adds to the
  modal via the same dynamic-discovery pattern as email actions.
- **Push trigger is manual per-invoice** in v2. Auto-push-on-issue is
  intentionally deferred — it introduces a "issued locally but push
  failed, what state are we in?" failure mode that complicates the
  issue button's contract. The single explicit `Push to QBO` keeps
  semantics clear; the scheduled pull poller is the only automatic
  sync direction.
- **Agent integration** (per-tab pattern from Projects/Proposals):
  `Ask agent ▾` menu on the detail toolbar with skills like
  `Reconcile this drift`, `Draft payment reminder`, `Explain the QBO
  push failure`. Each spawns a session with invoice context as seed.
- **Project-scoped view**: the project detail's **Invoices** tab is
  the same invoice list filtered to that project, with the budget
  rollup pulled forward into the tab's KPI strip (Budget · Invoiced ·
  Paid · Outstanding).
- **New API endpoints required**: see the **QBO endpoint contract**
  subsection below for full request/response shapes.

#### QBO endpoint contract

Seven new endpoints under two namespaces: per-invoice sync operations under `/api/invoicing/invoices/:id/`, and the OAuth + connection lifecycle under `/api/integrations/qbo/`. All return JSON; the OAuth `/connect` and `/callback` routes are the only ones that issue HTTP redirects.

**`POST /api/invoicing/invoices/:id/push`** — push the local invoice to QBO.

```jsonc
// Request: no body required; optional { force: true } to overwrite QBO regardless of drift
// Response 200
{
  "qboId": "12345",                       // QBO doc id; persisted to invoice.qbo_id
  "syncStatus": "synced",
  "lastSyncedAt": "2026-05-23T14:22:01Z",
  "qboDocNumber": "INV-1018"              // QBO's own number (informational)
}

// Errors
// 409 NOT_CONNECTED — qbo_connection missing or tokens expired; UI shows the banner
// 409 DRIFT — sync_status='drift'; client should route to the reconcile flow or set force:true
// 409 INVOICE_NOT_ISSUED — local invoice is still in Draft; QBO push requires issued state
// 502 QBO_ERROR — upstream QBO call failed; response details: { qboStatus, qboMessage }
```

The push is **idempotent over the local invoice id** — re-pushing an already-synced invoice updates the existing QBO doc in place via `qbo_id`. Emits `qbo.invoice_pushed` on success, `qbo.sync_failed` on the 502 path.

**`POST /api/invoicing/invoices/:id/pull`** — pull the canonical QBO invoice and merge into the local row.

```jsonc
// Request: no body
// Response 200
{
  "syncStatus": "synced" | "drift",
  "lastSyncedAt": "2026-05-23T14:22:01Z",
  "driftFields": ["customerEmail", "lineItems[2].amount"]  // present when syncStatus='drift'
}

// Errors
// 404 NOT_PUSHED — local invoice has no qbo_id; nothing to pull
// 409 NOT_CONNECTED
// 502 QBO_ERROR
```

The pull never overwrites local fields automatically when divergence is detected — it sets `sync_status='drift'`, records the diverging field paths, and emits `qbo.drift_detected`. The operator resolves via `/reconcile`. Successful no-drift pulls emit `qbo.invoice_pulled`.

**`POST /api/invoicing/invoices/:id/reconcile`** — UI-driven drift resolution.

```jsonc
// Request
{
  "strategy": "keep_local" | "accept_qbo" | "merge",
  "merged"?: {                             // required when strategy='merge'
    "customerEmail": "new@example.com",   // partial: only fields the operator overrode
    "lineItems": [ /* full replacement array */ ]
  }
}

// Response 200
{
  "syncStatus": "synced",
  "lastSyncedAt": "2026-05-23T14:23:14Z",
  "resolution": "keep_local" | "accept_qbo" | "merge"
}

// Errors
// 409 NOT_IN_DRIFT — current sync_status is not 'drift'; UI should refresh
// 409 NOT_CONNECTED
// 422 INVALID_MERGE — strategy='merge' but `merged` is missing or fails the invoice Zod schema
// 502 QBO_ERROR — when strategy='keep_local' or 'merge' triggers an outbound QBO update
```

`keep_local` pushes the local row to QBO (overwrite). `accept_qbo` writes the pulled-canonical values back into the local row. `merge` applies `merged` to the local row, then pushes. The route is the single authoritative drift-resolver — the `reconcile-drift` Skill (agent-mediated escape) calls this same endpoint after collecting the operator's choice via `request_user_input`.

**`GET /api/invoicing/qbo/status`** — connection state + last sync. Drives the `/invoicing` banner and the Settings → Integrations → QuickBooks Online panel.

```jsonc
// Response 200
{
  "connected": true,
  "realmId": "9341454031...",
  "companyName": "Knowles Industry Design Pty Ltd",
  "connectedAt": "2026-04-12T03:11:00Z",
  "tokenExpiresAt": "2026-08-12T03:11:00Z",
  "lastPushAt": "2026-05-23T14:22:01Z",
  "lastPullAt": "2026-05-23T13:00:00Z",
  "lastError": null                        // { code, message, at } on the last failed sync
}

// Response 200 (disconnected)
{ "connected": false }
```

The route always returns 200 — `connected: false` is the disconnected case, not an error. Token expiry is computed from the persisted `expires_at` (refresh tokens are auto-refreshed on the next call; the UI shows expiry as a heads-up, not an action item).

**`GET /api/integrations/qbo/connect`** — start the OAuth2 PKCE flow.

```
GET /api/integrations/qbo/connect
→ 302 Location: https://appcenter.intuit.com/connect/oauth2?...
```

The server generates a state token (one-time, 5-minute TTL, stored in-memory), constructs the QBO authorization URL with `scope=com.intuit.quickbooks.accounting`, and redirects. The frontend's `Connect` button is an `<a href="/api/integrations/qbo/connect">` — no fetch needed.

**`GET /api/integrations/qbo/callback`** — OAuth2 redirect target.

```
GET /api/integrations/qbo/callback?code=AB11...&realmId=934...&state=xyz
→ 302 Location: /settings?tab=integrations&qbo=connected   (success)
→ 302 Location: /settings?tab=integrations&qbo=error&reason=<code>  (failure)
```

Exchanges `code` for tokens, encrypts them (DPAPI on Windows; `.env` key fallback elsewhere), inserts/updates the single `qbo_connection` row, and redirects back into the SPA with a query-string status the Integrations panel reads to show a toast. On `state` mismatch or token-exchange failure, redirects with `qbo=error&reason=...`. The frontend NEVER calls this endpoint directly — it is only invoked by the QBO redirect.

**`POST /api/integrations/qbo/disconnect`** — revoke and clear tokens.

```jsonc
// Request: no body
// Response 200 — { ok: true }
// Errors: 404 NOT_CONNECTED
```

Calls QBO's revocation endpoint (best-effort — local clear happens regardless), deletes the `qbo_connection` row, emits `qbo.disconnected`. Any in-flight push/pull operations fail with `NOT_CONNECTED` on their next QBO call.

#### Token storage

`qbo_connection` is a single-row table (single-company in v2):

```sql
CREATE TABLE qbo_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),     -- enforce single row
  realm_id TEXT NOT NULL,
  company_name TEXT,
  access_token_encrypted BLOB NOT NULL,
  refresh_token_encrypted BLOB NOT NULL,
  expires_at INTEGER NOT NULL,                -- access-token expiry (ms epoch)
  connected_at INTEGER NOT NULL,
  last_push_at INTEGER,
  last_pull_at INTEGER,
  last_error_json TEXT
);
```

Encryption helper lives in `src/storage/secret-vault.ts` — DPAPI via Win32 `CryptProtectData` when `process.platform === 'win32'`, AES-GCM with key from `QBO_TOKEN_KEY` env var otherwise. Tokens never appear in logs, audit entries, or events — only `realmId` and `companyName` are surfaceable.

#### Audit + events

Every sync mutation writes an `audit_log` row with `module='invoicing'`, action in `{ 'invoice.push', 'invoice.pull', 'invoice.reconcile', 'qbo.connect', 'qbo.disconnect' }`, `target_id=invoice.id` (or `null` for connect/disconnect), and `project_id` resolved from the invoice's proposal → project chain. Events emitted: `qbo.invoice_pushed`, `qbo.invoice_pulled`, `qbo.drift_detected`, `qbo.sync_failed`, `qbo.connected`, `qbo.disconnected`.

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

### → Frontend grill session ← (complete — 2026-05-22)

Outcome recorded in [`../adr/0006-frontend-shell-architecture.md`](../adr/0006-frontend-shell-architecture.md):
chat-as-route, top bar + left sidebar + centred chat pane, uniform master/detail
for module panels, notification tray as the cross-page awareness channel, profile
management promoted from picker-only to full UI editor (new server endpoints
needed). Platform stack pinned: Vite + React 19 + React Router 6 + TanStack
Query + Zustand + shadcn/Tailwind + react-hook-form + zod + react-markdown.

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

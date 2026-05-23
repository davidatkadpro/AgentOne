import { randomUUID } from 'node:crypto'
import type { Db } from '../../../src/storage/db.js'
import type { EventBus } from '../../../src/core/events.js'
import type { AuditActor, AuditLog } from '../../../src/modules/audit-log.js'
import type { StorageAdapter } from '../../../src/storage/adapter.js'
import type { ProjectsService } from '../../projects/src/service.js'
import type { EmailSource } from './source.js'

export interface Email {
  id: string
  sourceKind: string
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

export interface IngestEmailInput {
  sourceKind: string
  sourceId: string
  receivedAt: number
  fromAddress: string
  fromName?: string | null
  subject?: string | null
  snippet?: string | null
  hasAttachments?: boolean
  metadata?: Record<string, unknown>
}

export interface ListEmailsOptions {
  isRead?: boolean
  filed?: boolean
  hasAttachments?: boolean
  projectId?: string
  limit?: number
}

export interface ActorContext {
  actor: AuditActor
}

export interface EmailAttachment {
  filename: string
  content: Buffer
}

export interface FileToProjectInput {
  emailId: string
  projectId: string
  /** Rendered markdown summary body. The service wraps it with frontmatter
   *  (from/subject/received_at/source) so callers only need the prose. */
  body: string
  attachments?: EmailAttachment[]
}

export interface FileToProjectResult {
  /** Relative folder under the storage root containing email.md + attachments. */
  folderPath: string
}

export interface EmailService {
  ingestEmail(input: IngestEmailInput, ctx: ActorContext): Email
  getEmail(id: string): Email | undefined
  getEmailBySourceRef(sourceKind: string, sourceId: string): Email | undefined
  listEmails(opts?: ListEmailsOptions): Email[]
  markRead(id: string, isRead: boolean, ctx: ActorContext): void
  markFiled(
    id: string,
    projectId: string,
    folderPath: string,
    ctx: ActorContext,
  ): void
  /** Write a summary + attachments under the project's `in/<yymmdd> - <slug>/`
   *  folder and link the email to the project. Throws if the email is already
   *  filed, the project doesn't exist, or the email row doesn't exist. */
  fileToProject(
    input: FileToProjectInput,
    ctx: ActorContext,
  ): Promise<FileToProjectResult>
  /** Pull the source's current list and ingest any messages we haven't seen
   *  yet. Returns the number of newly-ingested rows. Re-running is a no-op
   *  because ingestEmail is idempotent over (source_kind, source_id). */
  pollSource(source: EmailSource, ctx: ActorContext): Promise<{ ingested: number }>
  /** Ingest a single sourceId from the source (no list traversal). Used by
   *  the fs-watcher path so a new .eml arrival doesn't require a full re-scan. */
  ingestOne(
    source: EmailSource,
    sourceId: string,
    ctx: ActorContext,
  ): Promise<Email | null>
}

export interface EmailServiceDeps {
  db: Db
  eventBus: EventBus
  audit: AuditLog
  /** Required for fileToProject — resolves a project's folder_path. Optional
   *  here so tests that only exercise ingest/list can omit it. */
  projects?: ProjectsService
  /** Required for fileToProject — writes summary.md + attachments. */
  storage?: StorageAdapter
}

interface EmailRow {
  id: string
  source_kind: string
  source_id: string
  received_at: number
  from_address: string
  from_name: string | null
  subject: string | null
  snippet: string | null
  has_attachments: number
  is_read: number
  filed_project_id: string | null
  filed_folder_path: string | null
  filed_at: number | null
  metadata_json: string
  created_at: number
}

function yymmdd(ts: number): string {
  const d = new Date(ts)
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

// Subject → kebabish slug used inside the dated folder name. We allow spaces
// to remain because the folder name template is `<yymmdd> - <slug>`, but we
// strip filesystem-illegal characters and collapse runs to single hyphens
// within the slug body so they read cleanly in a file browser.
function slugify(raw: string | null | undefined): string {
  if (!raw) return 'email'
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return cleaned.length > 0 ? cleaned : 'email'
}

function rowToEmail(row: EmailRow): Email {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    receivedAt: row.received_at,
    fromAddress: row.from_address,
    fromName: row.from_name,
    subject: row.subject,
    snippet: row.snippet,
    hasAttachments: row.has_attachments === 1,
    isRead: row.is_read === 1,
    filedProjectId: row.filed_project_id,
    filedFolderPath: row.filed_folder_path,
    filedAt: row.filed_at,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  }
}

export function createEmailService(deps: EmailServiceDeps): EmailService {
  const insertStmt = deps.db.prepare(
    `INSERT INTO email
       (id, source_kind, source_id, received_at, from_address, from_name,
        subject, snippet, has_attachments, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const getByIdStmt = deps.db.prepare('SELECT * FROM email WHERE id = ?')
  const getBySourceStmt = deps.db.prepare(
    'SELECT * FROM email WHERE source_kind = ? AND source_id = ?',
  )
  const updateReadStmt = deps.db.prepare(
    'UPDATE email SET is_read = ? WHERE id = ?',
  )
  const updateFiledStmt = deps.db.prepare(
    `UPDATE email
       SET filed_project_id = ?, filed_folder_path = ?, filed_at = ?
     WHERE id = ?`,
  )

  return {
    ingestEmail(input, ctx) {
      // Idempotency: same (source_kind, source_id) returns the existing row
      // unchanged. The source poller can replay safely.
      const existing = getBySourceStmt.get(input.sourceKind, input.sourceId) as
        | EmailRow
        | undefined
      if (existing) return rowToEmail(existing)

      const id = randomUUID()
      const now = Date.now()
      const metadata = input.metadata ?? {}
      insertStmt.run(
        id,
        input.sourceKind,
        input.sourceId,
        input.receivedAt,
        input.fromAddress,
        input.fromName ?? null,
        input.subject ?? null,
        input.snippet ?? null,
        input.hasAttachments ? 1 : 0,
        JSON.stringify(metadata),
        now,
      )
      deps.audit.record({
        module: 'email',
        action: 'email.received',
        entityType: 'email',
        entityId: id,
        actor: ctx.actor,
        payload: {
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          subject: input.subject ?? null,
        },
      })
      void deps.eventBus.emit({
        type: 'email.received',
        emailId: id,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        ts: now,
      })
      return {
        id,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        receivedAt: input.receivedAt,
        fromAddress: input.fromAddress,
        fromName: input.fromName ?? null,
        subject: input.subject ?? null,
        snippet: input.snippet ?? null,
        hasAttachments: input.hasAttachments === true,
        isRead: false,
        filedProjectId: null,
        filedFolderPath: null,
        filedAt: null,
        metadata,
        createdAt: now,
      }
    },

    getEmail(id) {
      const row = getByIdStmt.get(id) as EmailRow | undefined
      return row ? rowToEmail(row) : undefined
    },

    getEmailBySourceRef(sourceKind, sourceId) {
      const row = getBySourceStmt.get(sourceKind, sourceId) as EmailRow | undefined
      return row ? rowToEmail(row) : undefined
    },

    listEmails(opts) {
      const limit = opts?.limit ?? 200
      const where: string[] = []
      const params: unknown[] = []
      if (opts?.isRead !== undefined) {
        where.push('is_read = ?')
        params.push(opts.isRead ? 1 : 0)
      }
      if (opts?.filed !== undefined) {
        where.push(opts.filed ? 'filed_project_id IS NOT NULL' : 'filed_project_id IS NULL')
      }
      if (opts?.hasAttachments !== undefined) {
        where.push('has_attachments = ?')
        params.push(opts.hasAttachments ? 1 : 0)
      }
      if (opts?.projectId !== undefined) {
        where.push('filed_project_id = ?')
        params.push(opts.projectId)
      }
      const sql =
        'SELECT * FROM email' +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY received_at DESC, rowid DESC LIMIT ?'
      params.push(limit)
      const rows = deps.db.prepare(sql).all(...params) as EmailRow[]
      return rows.map(rowToEmail)
    },

    markRead(id, isRead, ctx) {
      const row = getByIdStmt.get(id) as EmailRow | undefined
      if (!row) throw new Error(`Email not found: ${id}`)
      const current = row.is_read === 1
      if (current === isRead) return
      updateReadStmt.run(isRead ? 1 : 0, id)
      deps.audit.record({
        module: 'email',
        action: isRead ? 'email.read' : 'email.unread',
        entityType: 'email',
        entityId: id,
        actor: ctx.actor,
        payload: { isRead },
      })
      if (isRead) {
        void deps.eventBus.emit({ type: 'email.read', emailId: id, ts: Date.now() })
      }
    },

    markFiled(id, projectId, folderPath, ctx) {
      const row = getByIdStmt.get(id) as EmailRow | undefined
      if (!row) throw new Error(`Email not found: ${id}`)
      const now = Date.now()
      // The FK constraint on filed_project_id surfaces unknown projects as a
      // SqliteError; we let it propagate.
      updateFiledStmt.run(projectId, folderPath, now, id)
      deps.audit.record({
        module: 'email',
        action: 'email.filed',
        entityType: 'email',
        entityId: id,
        actor: ctx.actor,
        payload: { projectId, folderPath },
      })
      void deps.eventBus.emit({
        type: 'email.filed',
        emailId: id,
        projectId,
        folderPath,
        ts: now,
      })
    },

    async fileToProject(input, ctx) {
      if (!deps.projects || !deps.storage) {
        throw new Error(
          'EmailService.fileToProject requires `projects` and `storage` deps',
        )
      }
      const row = getByIdStmt.get(input.emailId) as EmailRow | undefined
      if (!row) throw new Error(`Email not found: ${input.emailId}`)
      if (row.filed_project_id) {
        throw new Error(`Email ${input.emailId} is already filed`)
      }
      const project = deps.projects.getProject(input.projectId)
      if (!project) {
        throw new Error(`Project not found: ${input.projectId}`)
      }
      if (!project.folderPath) {
        throw new Error(`Project ${input.projectId} has no folder_path`)
      }

      const datedSlug = `${yymmdd(row.received_at)} - ${slugify(row.subject)}`
      const folderPath = `${project.folderPath}/in/${datedSlug}`
      await deps.storage.ensureDir(folderPath)

      const fromHeader = row.from_name
        ? `${row.from_name} <${row.from_address}>`
        : row.from_address
      const receivedIso = new Date(row.received_at).toISOString()
      const frontmatter = [
        '---',
        `email_id: "${input.emailId}"`,
        `from: "${fromHeader.replace(/"/g, '\\"')}"`,
        `subject: "${(row.subject ?? '').replace(/"/g, '\\"')}"`,
        `received_at: "${receivedIso}"`,
        `source_kind: "${row.source_kind}"`,
        `source_id: "${row.source_id}"`,
        '---',
        '',
      ].join('\n')
      const summary = `${frontmatter}# ${row.subject ?? '(no subject)'}\n\n${input.body}\n`
      await deps.storage.write(`${folderPath}/email.md`, summary)

      for (const att of input.attachments ?? []) {
        // Caller-provided filenames may contain unsafe segments; sanitize.
        const safeName = att.filename.replace(/[\\/]/g, '_').replace(/^\.+/, '_')
        await deps.storage.write(`${folderPath}/${safeName}`, att.content)
      }

      const now = Date.now()
      updateFiledStmt.run(input.projectId, folderPath, now, input.emailId)
      deps.audit.record({
        module: 'email',
        action: 'email.filed',
        entityType: 'email',
        entityId: input.emailId,
        actor: ctx.actor,
        payload: { projectId: input.projectId, folderPath },
      })
      void deps.eventBus.emit({
        type: 'email.filed',
        emailId: input.emailId,
        projectId: input.projectId,
        folderPath,
        ts: now,
      })
      return { folderPath }
    },

    async pollSource(source, ctx) {
      const summaries = await source.list()
      let ingested = 0
      for (const s of summaries) {
        const before = getBySourceStmt.get(s.sourceKind, s.sourceId)
        if (before) continue
        const ingestInput: IngestEmailInput = {
          sourceKind: s.sourceKind,
          sourceId: s.sourceId,
          receivedAt: s.receivedAt,
          fromAddress: s.fromAddress,
          fromName: s.fromName,
          subject: s.subject,
          snippet: s.snippet,
          hasAttachments: s.hasAttachments,
        }
        // ingestEmail is internally idempotent; we still pre-check above to
        // count only first-time ingests for the route's return value.
        this.ingestEmail(ingestInput, ctx)
        ingested += 1
      }
      return { ingested }
    },

    async ingestOne(source, sourceId, ctx) {
      // Fast-path for the fs-watcher: look up just the one message and
      // ingest. The source.get() call carries the full body, but we only
      // need the summary fields. Idempotent via the (sourceKind, sourceId)
      // unique check below.
      const before = getBySourceStmt.get(source.kind, sourceId)
      if (before) return rowToEmail(before as EmailRow)
      let detail
      try {
        detail = await source.get(sourceId)
      } catch {
        return null
      }
      const ingestInput: IngestEmailInput = {
        sourceKind: source.kind,
        sourceId,
        receivedAt: detail.receivedAt,
        fromAddress: detail.fromAddress,
        fromName: detail.fromName,
        subject: detail.subject,
        snippet: detail.snippet,
        hasAttachments: detail.hasAttachments,
      }
      return this.ingestEmail(ingestInput, ctx)
    },
  }
}

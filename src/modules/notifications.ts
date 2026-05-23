import type { Db } from '../storage/db.js'
import type { EventBus } from '../core/events.js'

export type NotificationKind = 'info' | 'attention_needed' | 'error'
export type NotificationStatus = 'unread' | 'read' | 'resolved' | 'dismissed'

export interface NotificationInput {
  kind: NotificationKind
  title: string
  body: string
  sessionId?: string | null
  module?: string | null
  payload?: unknown
}

export interface Notification {
  id: number
  kind: NotificationKind
  title: string
  body: string
  sessionId: string | null
  module: string | null
  payload: unknown
  status: NotificationStatus
  createdAt: number
  resolvedAt: number | null
}

export interface Notifications {
  create(input: NotificationInput): Notification
  get(id: number): Notification | undefined
  list(opts?: { status?: NotificationStatus; limit?: number }): Notification[]
  markRead(id: number): void
  resolve(id: number): void
  dismiss(id: number): void
}

function ensureNotificationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL
        CHECK (kind IN ('info', 'attention_needed', 'error')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      session_id TEXT,
      module TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread'
        CHECK (status IN ('unread', 'read', 'resolved', 'dismissed')),
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_status
      ON notifications(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_session
      ON notifications(session_id, created_at);
  `)
}

interface NotificationRow {
  id: number
  kind: string
  title: string
  body: string
  session_id: string | null
  module: string | null
  payload_json: string
  status: string
  created_at: number
  resolved_at: number | null
}

const VALID_KINDS: ReadonlySet<NotificationKind> = new Set([
  'info',
  'attention_needed',
  'error',
])
const VALID_STATUSES: ReadonlySet<NotificationStatus> = new Set([
  'unread',
  'read',
  'resolved',
  'dismissed',
])

function parseKind(raw: string): NotificationKind {
  if (VALID_KINDS.has(raw as NotificationKind)) return raw as NotificationKind
  throw new Error(`Invalid notification kind in store: ${raw}`)
}

function parseStatus(raw: string): NotificationStatus {
  if (VALID_STATUSES.has(raw as NotificationStatus)) return raw as NotificationStatus
  throw new Error(`Invalid notification status in store: ${raw}`)
}

function rowToNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    kind: parseKind(row.kind),
    title: row.title,
    body: row.body,
    sessionId: row.session_id,
    module: row.module,
    payload: JSON.parse(row.payload_json),
    status: parseStatus(row.status),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

export interface CreateNotificationsDeps {
  /** Optional event bus. When provided, every mutation emits a
   *  `notification.{created,updated,resolved}` event so the UI (and any
   *  other bus subscriber) can react. */
  bus?: EventBus
}

export function createNotifications(db: Db, deps: CreateNotificationsDeps = {}): Notifications {
  ensureNotificationsTable(db)

  const insertStmt = db.prepare(
    `INSERT INTO notifications
       (kind, title, body, session_id, module, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const getStmt = db.prepare('SELECT * FROM notifications WHERE id = ?')
  const listAllStmt = db.prepare(
    'SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?',
  )
  const listByStatusStmt = db.prepare(
    'SELECT * FROM notifications WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  )
  const markReadStmt = db.prepare(
    "UPDATE notifications SET status = 'read' WHERE id = ? AND status = 'unread'",
  )
  const resolveStmt = db.prepare(
    "UPDATE notifications SET status = 'resolved', resolved_at = ? WHERE id = ?",
  )
  const dismissStmt = db.prepare(
    "UPDATE notifications SET status = 'dismissed' WHERE id = ?",
  )

  function emit(event: { type: 'notification.created' | 'notification.updated' | 'notification.resolved'; notificationId: number; kind?: NotificationKind; title?: string; body?: string; sessionId?: string | null; module?: string | null }): void {
    if (!deps.bus) return
    void deps.bus.emit({ ...event, ts: Date.now() } as never)
  }

  return {
    create(input) {
      const createdAt = Date.now()
      const payload = input.payload === undefined ? {} : input.payload
      const info = insertStmt.run(
        input.kind,
        input.title,
        input.body,
        input.sessionId ?? null,
        input.module ?? null,
        JSON.stringify(payload),
        createdAt,
      )
      const id = Number(info.lastInsertRowid)
      emit({
        type: 'notification.created',
        notificationId: id,
        kind: input.kind,
        title: input.title,
        body: input.body,
        sessionId: input.sessionId ?? null,
        module: input.module ?? null,
      })
      return {
        id,
        kind: input.kind,
        title: input.title,
        body: input.body,
        sessionId: input.sessionId ?? null,
        module: input.module ?? null,
        payload,
        status: 'unread',
        createdAt,
        resolvedAt: null,
      }
    },

    get(id) {
      const row = getStmt.get(id) as NotificationRow | undefined
      return row ? rowToNotification(row) : undefined
    },

    list(opts) {
      const limit = opts?.limit ?? 100
      const rows = (
        opts?.status
          ? listByStatusStmt.all(opts.status, limit)
          : listAllStmt.all(limit)
      ) as NotificationRow[]
      return rows.map(rowToNotification)
    },

    markRead(id) {
      markReadStmt.run(id)
      emit({ type: 'notification.updated', notificationId: id })
    },

    resolve(id) {
      resolveStmt.run(Date.now(), id)
      emit({ type: 'notification.resolved', notificationId: id })
    },

    dismiss(id) {
      dismissStmt.run(id)
      emit({ type: 'notification.updated', notificationId: id })
    },
  }
}

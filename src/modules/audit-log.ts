import type { Db } from '../storage/db.js'

export type AuditActor =
  | { type: 'agent'; sessionId: string }
  | { type: 'user' }
  | { type: 'scheduler'; id: string }
  | { type: 'hook'; id: string }
  | { type: 'module'; module: string }

export interface AuditEntryInput {
  module: string
  action: string
  entityType: string
  entityId: string
  actor: AuditActor
  payload?: unknown
  /** Optional denormalised project id used by `listByProject`. The Projects
   *  service threads this through for project/phase/task mutations so the
   *  Projects panel Activity tab can read via a partial index. */
  projectId?: string | null
}

export interface AuditLogEntry {
  id: number
  ts: number
  module: string
  action: string
  entityType: string
  entityId: string
  actor: AuditActor
  payload: unknown
  projectId: string | null
}

export interface ListByProjectOptions {
  limit?: number
  offset?: number
}

export interface AuditLog {
  record(input: AuditEntryInput): AuditLogEntry
  listByEntity(entityType: string, entityId: string): AuditLogEntry[]
  listByModule(module: string, opts?: { limit?: number }): AuditLogEntry[]
  listByProject(
    projectId: string,
    opts?: ListByProjectOptions,
  ): { entries: AuditLogEntry[]; hasMore: boolean }
}

function ensureAuditLogTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_log(module, ts);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id, ts);
  `)
  // P2P5: denormalise project_id onto audit_log so the Projects panel's
  // Activity tab can read via a partial index without a JOIN. Idempotent —
  // we sniff the column list before altering so re-running on an existing
  // db is a no-op.
  const cols = db.prepare("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'project_id')) {
    db.exec(`ALTER TABLE audit_log ADD COLUMN project_id TEXT`)
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_project
       ON audit_log (project_id, ts DESC)
       WHERE project_id IS NOT NULL`,
  )
}

interface AuditRow {
  id: number
  ts: number
  module: string
  action: string
  entity_type: string
  entity_id: string
  actor_json: string
  payload_json: string
  project_id: string | null
}

function rowToEntry(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    ts: row.ts,
    module: row.module,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actor: JSON.parse(row.actor_json) as AuditActor,
    payload: JSON.parse(row.payload_json),
    projectId: row.project_id,
  }
}

export function createAuditLog(db: Db): AuditLog {
  ensureAuditLogTable(db)

  const insertStmt = db.prepare(
    `INSERT INTO audit_log (ts, module, action, entity_type, entity_id, actor_json, payload_json, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const listByEntityStmt = db.prepare(
    `SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY ts ASC, id ASC`,
  )
  const listByModuleStmt = db.prepare(
    `SELECT * FROM audit_log WHERE module = ? ORDER BY ts DESC, id DESC LIMIT ?`,
  )
  const listByProjectStmt = db.prepare(
    `SELECT * FROM audit_log
     WHERE project_id = ?
     ORDER BY ts DESC, id DESC
     LIMIT ? OFFSET ?`,
  )
  const countByProjectStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE project_id = ?`,
  )

  return {
    record(input) {
      const ts = Date.now()
      const actorJson = JSON.stringify(input.actor)
      const payload = input.payload === undefined ? {} : input.payload
      const payloadJson = JSON.stringify(payload)
      const projectId = input.projectId ?? null
      const info = insertStmt.run(
        ts,
        input.module,
        input.action,
        input.entityType,
        input.entityId,
        actorJson,
        payloadJson,
        projectId,
      )
      return {
        id: Number(info.lastInsertRowid),
        ts,
        module: input.module,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        actor: input.actor,
        payload,
        projectId,
      }
    },

    listByEntity(entityType, entityId) {
      const rows = listByEntityStmt.all(entityType, entityId) as AuditRow[]
      return rows.map(rowToEntry)
    },

    listByModule(module, opts) {
      const limit = opts?.limit ?? 100
      const rows = listByModuleStmt.all(module, limit) as AuditRow[]
      return rows.map(rowToEntry)
    },

    listByProject(projectId, opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500)
      const offset = Math.max(opts?.offset ?? 0, 0)
      const rows = listByProjectStmt.all(projectId, limit, offset) as AuditRow[]
      const total = (countByProjectStmt.get(projectId) as { n: number } | undefined)?.n ?? 0
      return {
        entries: rows.map(rowToEntry),
        hasMore: offset + rows.length < total,
      }
    },
  }
}

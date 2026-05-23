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
}

export interface AuditLog {
  record(input: AuditEntryInput): AuditLogEntry
  listByEntity(entityType: string, entityId: string): AuditLogEntry[]
  listByModule(module: string, opts?: { limit?: number }): AuditLogEntry[]
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
  }
}

export function createAuditLog(db: Db): AuditLog {
  ensureAuditLogTable(db)

  const insertStmt = db.prepare(
    `INSERT INTO audit_log (ts, module, action, entity_type, entity_id, actor_json, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const listByEntityStmt = db.prepare(
    `SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY ts ASC, id ASC`,
  )
  const listByModuleStmt = db.prepare(
    `SELECT * FROM audit_log WHERE module = ? ORDER BY ts DESC, id DESC LIMIT ?`,
  )

  return {
    record(input) {
      const ts = Date.now()
      const actorJson = JSON.stringify(input.actor)
      const payload = input.payload === undefined ? {} : input.payload
      const payloadJson = JSON.stringify(payload)
      const info = insertStmt.run(
        ts,
        input.module,
        input.action,
        input.entityType,
        input.entityId,
        actorJson,
        payloadJson,
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
  }
}

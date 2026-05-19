import Database from 'better-sqlite3'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export type Db = Database.Database
export type PositionalStmt = Database.Statement<unknown[]>
export type NamedStmt<T extends Record<string, unknown> = Record<string, unknown>> =
  Database.Statement<T>

export interface CreateDatabaseOptions {
  path: string
  /** Skip parent-directory creation. For ":memory:" or pre-existing paths. */
  skipMkdir?: boolean
}

/**
 * Open the shared SQLite database used by ConversationStore, WikiEngine, and
 * future indexes. WAL + synchronous=NORMAL is the durable-yet-fast posture for
 * an append-heavy single-writer workload on local disks.
 */
export function createDatabase(opts: CreateDatabaseOptions): Db {
  if (!opts.skipMkdir && opts.path !== ':memory:') {
    mkdirSync(dirname(opts.path), { recursive: true })
  }
  const db = new Database(opts.path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  return db
}

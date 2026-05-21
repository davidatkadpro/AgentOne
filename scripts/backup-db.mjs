#!/usr/bin/env node
/**
 * One-shot DB backup. Writes a timestamped snapshot of the live SQLite
 * database to `<storageRoot>/backups/agentone-<timestamp>.db` (or a
 * destination passed on the command line).
 *
 * The SQLite online-backup API is concurrent-write-safe — running this
 * against a live server is fine. Per the planning doc this catches the
 * "lose expert spend + audit log on DB corruption" gap.
 *
 * Usage:
 *   node scripts/backup-db.mjs                  # default destination
 *   node scripts/backup-db.mjs /path/to/dest    # explicit destination
 *
 * Env:
 *   DB_PATH (default: ./data/agentone.db)
 *   STORAGE_ROOT (default: ./storage) — used to derive the default
 *     backup directory when no explicit destination is passed
 */
import { resolve, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { createDatabase } from '../src/storage/db.ts'
import { backupDatabase } from '../src/storage/backup.ts'

const dbPath = process.env.DB_PATH ?? './data/agentone.db'
const storageRoot = process.env.STORAGE_ROOT ?? './storage'
const destinationArg = process.argv[2]
const destination = destinationArg
  ? resolve(destinationArg)
  : resolve(join(storageRoot, 'backups'))

console.log(`Backing up ${dbPath}`)
console.log(`Destination: ${destination}`)

const db = createDatabase({ path: resolve(dbPath) })
try {
  const result = await backupDatabase(db, { destination })
  const info = await stat(result.path).catch(() => null)
  const bytes = info?.size ?? result.bytes
  const kb = (bytes / 1024).toFixed(1)
  console.log(`✓ wrote ${result.path}`)
  console.log(`  ${kb} kB in ${result.durationMs} ms`)
} catch (err) {
  console.error(`✗ backup failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
} finally {
  db.close()
}

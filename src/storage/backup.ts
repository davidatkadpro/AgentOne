import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Db } from './db.js'

export interface BackupResult {
  /** Absolute path of the produced backup file. */
  path: string
  /** Size of the backup file in bytes. */
  bytes: number
  /** Wall-clock duration of the backup operation. */
  durationMs: number
}

export interface BackupOptions {
  /**
   * Destination — either a full file path or a directory. When a
   * directory (ends with a path separator or has no extension), a
   * timestamped filename is generated inside it.
   */
  destination: string
  /** Override the timestamp for tests. Defaults to `new Date()`. */
  now?: () => Date
  /** Skip mkdir on the destination's parent directory. */
  skipMkdir?: boolean
}

/**
 * Snapshot the live SQLite database to a file using better-sqlite3's
 * online backup API. The destination is opened, written, and closed
 * atomically — the source DB remains usable throughout. SQLite handles
 * locking so a concurrent writer sees a consistent snapshot.
 *
 * Naming convention when `destination` is a directory:
 *   agentone-YYYY-MM-DDTHH-MM-SS.db
 * (colons replaced with hyphens so the filename is Windows-safe.)
 */
export async function backupDatabase(
  db: Db,
  options: BackupOptions,
): Promise<BackupResult> {
  const start = Date.now()
  const now = (options.now ?? (() => new Date()))()
  const isDir = looksLikeDirectory(options.destination)
  const path = isDir
    ? join(options.destination, defaultFilename(now))
    : options.destination
  if (!options.skipMkdir) {
    await mkdir(dirname(path), { recursive: true })
  }
  // better-sqlite3 returns a Promise from db.backup; awaiting it ensures
  // the snapshot has flushed before we return. The library handles the
  // VFS-level locking for us.
  const info = await db.backup(path)
  const durationMs = Date.now() - start
  return {
    path,
    // info.totalPages * info.pageSize would be more accurate but Database
    // doesn't surface page size cleanly. Caller can fs.stat for precision.
    bytes: typeof info === 'object' && info !== null && 'totalPages' in info
      ? Number((info as { totalPages: number }).totalPages) * 4096
      : 0,
    durationMs,
  }
}

function looksLikeDirectory(p: string): boolean {
  if (p.endsWith('/') || p.endsWith('\\')) return true
  // Heuristic: no extension means caller meant a directory.
  const base = p.replace(/.*[/\\]/, '')
  return !base.includes('.')
}

/** Filename in the form `agentone-2026-05-22T07-21-30.db`. */
export function defaultFilename(now: Date): string {
  // Strip subseconds + replace colons (illegal on Windows).
  const stamp = now.toISOString().replace(/\..*/, '').replace(/:/g, '-')
  return `agentone-${stamp}.db`
}

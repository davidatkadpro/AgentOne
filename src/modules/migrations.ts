import type { Db } from '../storage/db.js'

export interface Migration {
  version: number
  name: string
  sql: string
}

export interface MigrationResult {
  module: string
  applied: Array<{ version: number; name: string }>
  skipped: number[]
  failed: { version: number; name: string; error: string } | null
}

function ensureSchemaMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      module TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (module, version)
    );
  `)
}

export function applyModuleMigrations(
  db: Db,
  module: string,
  migrations: Migration[],
): MigrationResult {
  ensureSchemaMigrationsTable(db)
  const insertStmt = db.prepare(
    'INSERT INTO schema_migrations (module, version, name, applied_at) VALUES (?, ?, ?, ?)',
  )
  const appliedVersionsRows = db
    .prepare('SELECT version FROM schema_migrations WHERE module = ?')
    .all(module) as Array<{ version: number }>
  const alreadyApplied = new Set(appliedVersionsRows.map((r) => r.version))

  const applied: Array<{ version: number; name: string }> = []
  const skipped: number[] = []
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  for (const m of ordered) {
    if (alreadyApplied.has(m.version)) {
      skipped.push(m.version)
      continue
    }
    const tx = db.transaction(() => {
      db.exec(m.sql)
      insertStmt.run(module, m.version, m.name, Date.now())
    })
    try {
      tx()
      applied.push({ version: m.version, name: m.name })
    } catch (err) {
      return {
        module,
        applied,
        skipped,
        failed: {
          version: m.version,
          name: m.name,
          error: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }
  return { module, applied, skipped, failed: null }
}

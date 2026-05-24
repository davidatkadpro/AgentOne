import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { applyModuleMigrations, type Migration } from '@/modules/migrations.js'
import type { Db } from '@/storage/db.js'

/**
 * Reads every `NNN_<name>.sql` under `modules/<name>/schema/` and applies it.
 * Tests use this instead of hard-coding 001_init.sql so adding migrations
 * (e.g. 002_qbo.sql) doesn't break unrelated harnesses.
 */
export function applyAllMigrationsForModule(db: Db, name: string): void {
  const dir = join(process.cwd(), 'modules', name, 'schema')
  const files = readdirSync(dir)
    .filter((f) => /^\d+_[\w-]+\.sql$/.test(f))
    .sort()
  const migrations: Migration[] = files.map((file) => {
    const match = /^(\d+)_(.+)\.sql$/.exec(file)
    if (!match || match[1] === undefined || match[2] === undefined) {
      throw new Error(`Bad migration filename: ${file}`)
    }
    return {
      version: Number(match[1]),
      name: `${match[1]}_${match[2]}`,
      sql: readFileSync(join(dir, file), 'utf-8'),
    }
  })
  applyModuleMigrations(db, name, migrations)
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations, type Migration } from '@/modules/migrations.js'

interface Harness {
  db: Db
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  return { db }
}

function disposeHarness(h: Harness): void {
  h.db.close()
}

describe('applyModuleMigrations — fresh application', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('runs the SQL and records the version on a fresh database', () => {
    const migration: Migration = {
      version: 1,
      name: '001_init',
      sql: `CREATE TABLE project (
              id TEXT PRIMARY KEY,
              number TEXT NOT NULL UNIQUE
            );`,
    }

    const result = applyModuleMigrations(h.db, 'projects', [migration])

    const table = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project'")
      .get() as { name: string } | undefined
    expect(table?.name).toBe('project')

    const row = h.db
      .prepare(
        "SELECT module, version, name FROM schema_migrations WHERE module = 'projects' AND version = 1",
      )
      .get() as { module: string; version: number; name: string } | undefined
    expect(row).toEqual({ module: 'projects', version: 1, name: '001_init' })

    expect(result.applied).toEqual([{ version: 1, name: '001_init' }])
    expect(result.skipped).toEqual([])
    expect(result.failed).toBeNull()
  })
})

describe('applyModuleMigrations — idempotent re-run', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('skips versions already recorded in schema_migrations', () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: '001_init',
        sql: `CREATE TABLE project (id TEXT PRIMARY KEY);`,
      },
    ]

    applyModuleMigrations(h.db, 'projects', migrations)
    const result = applyModuleMigrations(h.db, 'projects', migrations)

    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([1])
    expect(result.failed).toBeNull()

    const rows = h.db
      .prepare("SELECT COUNT(*) as n FROM schema_migrations WHERE module = 'projects'")
      .get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it('applies only the new migration when a later version is appended', () => {
    const v1: Migration = {
      version: 1,
      name: '001_init',
      sql: `CREATE TABLE project (id TEXT PRIMARY KEY);`,
    }
    const v2: Migration = {
      version: 2,
      name: '002_add_number',
      sql: `ALTER TABLE project ADD COLUMN number TEXT;`,
    }

    applyModuleMigrations(h.db, 'projects', [v1])
    const result = applyModuleMigrations(h.db, 'projects', [v1, v2])

    expect(result.applied).toEqual([{ version: 2, name: '002_add_number' }])
    expect(result.skipped).toEqual([1])

    const cols = h.db.pragma('table_info(project)') as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('number')
  })
})

describe('applyModuleMigrations — ordering', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('applies migrations in ascending version order regardless of input order', () => {
    const v1: Migration = {
      version: 1,
      name: '001_init',
      sql: `CREATE TABLE project (id TEXT PRIMARY KEY);`,
    }
    const v2: Migration = {
      version: 2,
      name: '002_add_number',
      sql: `ALTER TABLE project ADD COLUMN number TEXT;`,
    }

    const result = applyModuleMigrations(h.db, 'projects', [v2, v1])

    expect(result.applied).toEqual([
      { version: 1, name: '001_init' },
      { version: 2, name: '002_add_number' },
    ])
    expect(result.failed).toBeNull()
  })
})

describe('applyModuleMigrations — failure semantics', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('rolls back the failing migration, reports it, and stops the run', () => {
    const v1: Migration = {
      version: 1,
      name: '001_init',
      sql: `CREATE TABLE project (id TEXT PRIMARY KEY);`,
    }
    const v2: Migration = {
      version: 2,
      name: '002_broken',
      sql: `
        CREATE TABLE phase (id TEXT PRIMARY KEY);
        CREATE TABLE phase (id TEXT PRIMARY KEY);
      `,
    }
    const v3: Migration = {
      version: 3,
      name: '003_should_not_run',
      sql: `CREATE TABLE task (id TEXT PRIMARY KEY);`,
    }

    const result = applyModuleMigrations(h.db, 'projects', [v1, v2, v3])

    expect(result.applied).toEqual([{ version: 1, name: '001_init' }])
    expect(result.failed).not.toBeNull()
    expect(result.failed?.version).toBe(2)
    expect(result.failed?.name).toBe('002_broken')
    expect(result.failed?.error).toMatch(/phase/i)

    const phaseTable = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='phase'")
      .get()
    expect(phaseTable).toBeUndefined()

    const taskTable = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task'")
      .get()
    expect(taskTable).toBeUndefined()

    const versions = h.db
      .prepare("SELECT version FROM schema_migrations WHERE module = 'projects' ORDER BY version")
      .all() as Array<{ version: number }>
    expect(versions.map((r) => r.version)).toEqual([1])
  })
})

describe('applyModuleMigrations — per-module isolation', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('two modules can share a version number without colliding', () => {
    const projectsV1: Migration = {
      version: 1,
      name: '001_init',
      sql: `CREATE TABLE project (id TEXT PRIMARY KEY);`,
    }
    const emailV1: Migration = {
      version: 1,
      name: '001_init',
      sql: `CREATE TABLE email (id TEXT PRIMARY KEY);`,
    }

    const projectsResult = applyModuleMigrations(h.db, 'projects', [projectsV1])
    const emailResult = applyModuleMigrations(h.db, 'email', [emailV1])

    expect(projectsResult.applied).toEqual([{ version: 1, name: '001_init' }])
    expect(emailResult.applied).toEqual([{ version: 1, name: '001_init' }])
    expect(projectsResult.failed).toBeNull()
    expect(emailResult.failed).toBeNull()

    const rows = h.db
      .prepare('SELECT module, version FROM schema_migrations ORDER BY module')
      .all() as Array<{ module: string; version: number }>
    expect(rows).toEqual([
      { module: 'email', version: 1 },
      { module: 'projects', version: 1 },
    ])
  })

  it("applying projects migrations does not re-run them for email's same version", () => {
    const projectsV1: Migration = {
      version: 1,
      name: '001_init',
      sql: `CREATE TABLE project (id TEXT PRIMARY KEY);`,
    }
    const emailV1: Migration = {
      version: 1,
      name: '001_init',
      sql: `CREATE TABLE email (id TEXT PRIMARY KEY);`,
    }

    applyModuleMigrations(h.db, 'projects', [projectsV1])
    const emailResult = applyModuleMigrations(h.db, 'email', [emailV1])

    expect(emailResult.applied).toEqual([{ version: 1, name: '001_init' }])
    expect(emailResult.skipped).toEqual([])
  })
})

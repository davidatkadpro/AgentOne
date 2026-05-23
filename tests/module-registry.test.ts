import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, type Db } from '@/storage/db.js'
import { bootModules, type ModuleRegistry } from '@/modules/registry.js'

interface Harness {
  db: Db
  rootDir: string
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const rootDir = mkdtempSync(join(tmpdir(), 'agentone-modules-'))
  return { db, rootDir }
}

function disposeHarness(h: Harness): void {
  h.db.close()
  rmSync(h.rootDir, { recursive: true, force: true })
}

function writeModule(
  rootDir: string,
  name: string,
  opts: {
    description?: string
    version?: string
    dependsOn?: string[]
    migrations?: Array<{ filename: string; sql: string }>
    extraFrontmatter?: Record<string, unknown>
  } = {},
): void {
  const moduleDir = join(rootDir, name)
  mkdirSync(moduleDir, { recursive: true })

  const fm: Record<string, unknown> = {
    name,
    description: opts.description ?? `${name} module`,
    version: opts.version ?? '0.1.0',
    ...(opts.dependsOn ? { depends_on: opts.dependsOn } : {}),
    ...opts.extraFrontmatter,
  }
  const yamlEntries = Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map((x) => `  - ${x}`).join('\n')}`
      }
      return `${k}: ${v}`
    })
    .join('\n')
  writeFileSync(
    join(moduleDir, 'MODULE.md'),
    `---\n${yamlEntries}\n---\n\n# ${name}\n`,
    'utf-8',
  )

  if (opts.migrations && opts.migrations.length > 0) {
    const schemaDir = join(moduleDir, 'schema')
    mkdirSync(schemaDir, { recursive: true })
    for (const m of opts.migrations) {
      writeFileSync(join(schemaDir, m.filename), m.sql, 'utf-8')
    }
  }
}

describe('bootModules — single module happy path', () => {
  let h: Harness
  let registry: ModuleRegistry
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('discovers the module, applies its migration, and exposes a handle', async () => {
    writeModule(h.rootDir, 'projects', {
      description: 'Project records',
      version: '0.1.0',
      migrations: [
        {
          filename: '001_init.sql',
          sql: `CREATE TABLE project (
                  id TEXT PRIMARY KEY,
                  number TEXT NOT NULL UNIQUE
                );`,
        },
      ],
    })

    registry = await bootModules({ db: h.db, rootDir: h.rootDir })

    const handle = registry.get('projects')
    expect(handle).toBeDefined()
    expect(handle?.name).toBe('projects')
    expect(handle?.status).toBe('active')
    expect(handle?.manifest.description).toBe('Project records')
    expect(handle?.manifest.version).toBe('0.1.0')

    const projectTable = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project'")
      .get()
    expect(projectTable).toBeDefined()

    const applied = h.db
      .prepare("SELECT version, name FROM schema_migrations WHERE module = 'projects'")
      .all() as Array<{ version: number; name: string }>
    expect(applied).toEqual([{ version: 1, name: '001_init' }])
  })
})

describe('bootModules — dependency ordering', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('migrates a depending module after its dependency', async () => {
    writeModule(h.rootDir, 'invoicing', {
      dependsOn: ['projects'],
      migrations: [
        { filename: '001_init.sql', sql: 'CREATE TABLE invoice (id TEXT PRIMARY KEY);' },
      ],
    })
    writeModule(h.rootDir, 'projects', {
      migrations: [
        { filename: '001_init.sql', sql: 'CREATE TABLE project (id TEXT PRIMARY KEY);' },
      ],
    })

    const registry = await bootModules({ db: h.db, rootDir: h.rootDir })

    expect(registry.get('projects')?.status).toBe('active')
    expect(registry.get('invoicing')?.status).toBe('active')

    const rows = h.db
      .prepare(
        "SELECT module, applied_at FROM schema_migrations WHERE module IN ('projects', 'invoicing') ORDER BY rowid ASC",
      )
      .all() as Array<{ module: string; applied_at: number }>

    expect(rows.map((r) => r.module)).toEqual(['projects', 'invoicing'])
  })

  it('marks a module degraded when a depends_on target is missing', async () => {
    writeModule(h.rootDir, 'invoicing', {
      dependsOn: ['projects'],
      migrations: [
        { filename: '001_init.sql', sql: 'CREATE TABLE invoice (id TEXT PRIMARY KEY);' },
      ],
    })
    writeModule(h.rootDir, 'email', {
      migrations: [
        { filename: '001_init.sql', sql: 'CREATE TABLE email (id TEXT PRIMARY KEY);' },
      ],
    })

    const registry = await bootModules({ db: h.db, rootDir: h.rootDir })

    expect(registry.get('email')?.status).toBe('active')

    const invoicing = registry.get('invoicing')
    expect(invoicing?.status).toBe('degraded')
    expect(invoicing?.degradedReason).toContain('projects')

    const invoiceTable = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invoice'")
      .get()
    expect(invoiceTable).toBeUndefined()
  })

  it('marks modules in a dependency cycle as degraded without crashing', async () => {
    writeModule(h.rootDir, 'a', {
      dependsOn: ['b'],
      migrations: [
        { filename: '001_init.sql', sql: 'CREATE TABLE a_table (id TEXT PRIMARY KEY);' },
      ],
    })
    writeModule(h.rootDir, 'b', {
      dependsOn: ['a'],
      migrations: [
        { filename: '001_init.sql', sql: 'CREATE TABLE b_table (id TEXT PRIMARY KEY);' },
      ],
    })
    writeModule(h.rootDir, 'standalone', {
      migrations: [
        { filename: '001_init.sql', sql: 'CREATE TABLE standalone_table (id TEXT PRIMARY KEY);' },
      ],
    })

    const registry = await bootModules({ db: h.db, rootDir: h.rootDir })

    expect(registry.get('a')?.status).toBe('degraded')
    expect(registry.get('a')?.degradedReason).toMatch(/cycle/i)
    expect(registry.get('b')?.status).toBe('degraded')
    expect(registry.get('b')?.degradedReason).toMatch(/cycle/i)
    expect(registry.get('standalone')?.status).toBe('active')

    const standaloneTable = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='standalone_table'")
      .get()
    expect(standaloneTable).toBeDefined()
  })
})

describe('bootModules — migration failures', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('marks a module with a failing migration degraded; other modules still boot', async () => {
    writeModule(h.rootDir, 'broken', {
      migrations: [
        {
          filename: '001_init.sql',
          sql: `CREATE TABLE thing (id TEXT PRIMARY KEY);
                CREATE TABLE thing (id TEXT PRIMARY KEY);`,
        },
      ],
    })
    writeModule(h.rootDir, 'ok', {
      migrations: [
        { filename: '001_init.sql', sql: 'CREATE TABLE ok_table (id TEXT PRIMARY KEY);' },
      ],
    })

    const registry = await bootModules({ db: h.db, rootDir: h.rootDir })

    const broken = registry.get('broken')
    expect(broken?.status).toBe('degraded')
    expect(broken?.degradedReason).toMatch(/migration/)
    expect(broken?.degradedReason).toMatch(/v1/)

    expect(registry.get('ok')?.status).toBe('active')
  })
})

describe('bootModules — manifest validation', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('marks a module degraded when MODULE.md is missing required fields', async () => {
    const moduleDir = join(h.rootDir, 'incomplete')
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(
      join(moduleDir, 'MODULE.md'),
      `---\nname: incomplete\n---\n\n# Incomplete\n`,
      'utf-8',
    )
    mkdirSync(join(moduleDir, 'schema'), { recursive: true })
    writeFileSync(
      join(moduleDir, 'schema', '001_init.sql'),
      'CREATE TABLE incomplete_t (id TEXT);',
      'utf-8',
    )

    const registry = await bootModules({ db: h.db, rootDir: h.rootDir })
    const handle = registry.get('incomplete')
    expect(handle?.status).toBe('degraded')
    expect(handle?.degradedReason).toMatch(/(description|version)/)

    const tableExists = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='incomplete_t'")
      .get()
    expect(tableExists).toBeUndefined()
  })

  it("ignores a folder with no MODULE.md (not a module)", async () => {
    mkdirSync(join(h.rootDir, 'just-a-folder'), { recursive: true })
    writeModule(h.rootDir, 'real', {
      migrations: [
        { filename: '001_init.sql', sql: 'CREATE TABLE real_t (id TEXT PRIMARY KEY);' },
      ],
    })

    const registry = await bootModules({ db: h.db, rootDir: h.rootDir })
    expect(registry.get('just-a-folder')).toBeUndefined()
    expect(registry.get('real')?.status).toBe('active')
  })
})

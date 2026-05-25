import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import {
  createProjectsService,
  type ProjectsService,
} from '../modules/projects/src/service.js'
import {
  parameters as suggestParams,
  handler as suggestHandler,
} from '../modules/email/skills/create-new-project/tools/suggest-next-project-number.js'
import type { ToolContext } from '@/skills/tool.js'

interface Harness {
  db: Db
  projects: ProjectsService
  modulesRegistry: NonNullable<ToolContext['services']>['modules']
}

function fakeCtx(h: Harness): ToolContext {
  return {
    sessionId: 'test',
    agentProfile: 'ops',
    permissions: undefined as never,
    expertSpend: undefined as never,
    services: {
      modules: h.modulesRegistry,
    } as never,
  }
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const projectsSql = readFileSync(
    join(process.cwd(), 'modules', 'projects', 'schema', '001_init.sql'),
    'utf-8',
  )
  applyModuleMigrations(db, 'projects', [{ version: 1, name: '001_init', sql: projectsSql }])
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const projects = createProjectsService({ db, eventBus: bus, audit })
  const modulesRegistry: NonNullable<ToolContext['services']>['modules'] = {
    get: (name) =>
      name === 'projects'
        ? {
            name: 'projects',
            manifest: undefined as never,
            rootPath: '',
            status: 'active',
            service: projects,
          }
        : undefined,
    getActiveService: <T>(name: string): T | undefined =>
      name === 'projects' ? (projects as unknown as T) : undefined,
    list: () => [],
  }
  return { db, projects, modulesRegistry }
}

describe('suggest_next_project_number', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  function thisYearPrefix(): string {
    return String(new Date().getUTCFullYear() % 100).padStart(2, '0')
  }

  it('returns <YY>001 when no projects exist', async () => {
    const result = await suggestHandler(suggestParams.parse({}), fakeCtx(h))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({
        suggested_number: `${thisYearPrefix()}001`,
      })
    }
  })

  it('increments past the highest existing <YY>### number', async () => {
    const prefix = thisYearPrefix()
    h.projects.createProject(
      { number: `${prefix}001`, name: 'a' },
      { actor: { type: 'user' } },
    )
    h.projects.createProject(
      { number: `${prefix}005`, name: 'b' },
      { actor: { type: 'user' } },
    )
    const result = await suggestHandler(suggestParams.parse({}), fakeCtx(h))
    if (result.ok) {
      expect(result.value).toMatchObject({
        suggested_number: `${prefix}006`,
      })
    }
  })

  it('ignores numbers from previous years', async () => {
    const prefix = thisYearPrefix()
    h.projects.createProject(
      { number: `99999`, name: 'old' },
      { actor: { type: 'user' } },
    )
    const result = await suggestHandler(suggestParams.parse({}), fakeCtx(h))
    if (result.ok) {
      expect(result.value).toMatchObject({
        suggested_number: `${prefix}001`,
      })
    }
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import {
  createProjectsService,
  type ProjectsService,
} from '../modules/projects/src/service.js'
import { registerProposalsActions } from '../modules/proposals/src/actions.js'
import type { Orchestrator } from '@/orchestrator/turn.js'

interface Harness {
  db: Db
  app: FastifyInstance
  projects: ProjectsService
  skillsDir: string
  fakeOrchestrator: { spawnSession: ReturnType<typeof vi.fn> }
}

async function newHarness(): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const projects = createProjectsService({ db, eventBus: bus, audit })
  const skillsDir = await mkdtemp(join(tmpdir(), 'agentone-prop-actions-'))
  await mkdir(join(skillsDir, 'build-estimate'), { recursive: true })
  await writeFile(
    join(skillsDir, 'build-estimate', 'SKILL.md'),
    [
      '---',
      'name: build-estimate',
      'description: Build a draft estimate',
      'label: Build estimate',
      'default_profile: ops',
      'prompt_template: |',
      "  Build an estimate for project {{project.number}} from scope {{args.scopeFilePath}}.",
      '---',
      '',
      '# body',
    ].join('\n'),
  )
  const fakeOrchestrator = {
    spawnSession: vi.fn(async () => ({
      session: { id: 'spawned-1' },
      handle: { stream: (async function* () {})() },
    })),
  }
  const app = Fastify({ logger: false })
  await registerProposalsActions(app, {
    orchestrator: fakeOrchestrator as unknown as Orchestrator,
    projects,
    skillsDir,
    eventBus: bus,
  })
  await app.ready()
  return { db, app, projects, skillsDir, fakeOrchestrator }
}

async function dispose(h: Harness): Promise<void> {
  await h.app.close()
  h.db.close()
  await rm(h.skillsDir, { recursive: true, force: true })
}

describe('Proposals action dispatcher', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  function makeProject(): string {
    return h.projects.createProject(
      { number: '25001', name: 'Riverside', folderPath: 'projects/25001-r' },
      { actor: { type: 'user' } },
    ).id
  }

  it('POST /api/proposals/actions spawns a session with the rendered template', async () => {
    const projectId = makeProject()
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/proposals/actions',
      payload: {
        action: 'build-estimate',
        contextId: projectId,
        args: { scopeFilePath: 'projects/25001-r/in/250520/scope.md' },
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { sessionId: string; action: string }
    expect(body.sessionId).toBe('spawned-1')
    expect(body.action).toBe('build-estimate')
    expect(h.fakeOrchestrator.spawnSession).toHaveBeenCalledTimes(1)
    const spawn = h.fakeOrchestrator.spawnSession.mock.calls[0][0]
    expect(spawn.spawnedBy).toBe('modules/proposals/build-estimate')
    expect(spawn.agentProfile).toBe('ops')
    expect(spawn.initialMessage).toContain('25001')
    expect(spawn.initialMessage).toContain('scope.md')
  })

  it('POST 404s an unknown skill name', async () => {
    const projectId = makeProject()
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/proposals/actions',
      payload: { action: 'no-such', contextId: projectId },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'UNKNOWN_ACTION' })
  })

  it('POST 404s when the project context does not exist', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/proposals/actions',
      payload: { action: 'build-estimate', contextId: 'ghost' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'PROJECT_NOT_FOUND' })
  })

  it('POST 400s on an empty body', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/proposals/actions',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('legacy v1 path also dispatches', async () => {
    const projectId = makeProject()
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/proposals/actions',
      payload: { action: 'build-estimate', contextId: projectId },
    })
    expect(res.statusCode).toBe(200)
  })
})

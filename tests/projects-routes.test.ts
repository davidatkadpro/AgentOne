import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import {
  createProjectsService,
  type ProjectsService,
} from '../modules/projects/src/service.js'
import { registerProjectsRoutes } from '../modules/projects/src/routes.js'

interface Harness {
  db: Db
  service: ProjectsService
  app: FastifyInstance
}

async function newHarness(): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  const service = createProjectsService({
    db,
    eventBus: new EventBus(),
    audit: createAuditLog(db),
  })
  const app = Fastify({ logger: false })
  await registerProjectsRoutes(app, { service })
  await app.ready()
  return { db, service, app }
}

async function disposeHarness(h: Harness): Promise<void> {
  await h.app.close()
  h.db.close()
}

describe('Projects routes', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await disposeHarness(h)
  })

  it('POST /api/v1/projects creates a project and returns 201 with the row', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { number: '24001', name: 'Riverside' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { project: { id: string; number: string; status: string } }
    expect(body.project.id).toBeTruthy()
    expect(body.project.number).toBe('24001')
    expect(body.project.status).toBe('pending')
  })

  it('POST returns 409 when the project number is already used', async () => {
    h.service.createProject(
      { number: '24001', name: 'First' },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { number: '24001', name: 'Second' },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: string }
    expect(body.error).toBe('DUPLICATE_PROJECT_NUMBER')
  })

  it('POST returns 400 when required fields are missing', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'No number' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET /api/v1/projects lists projects newest-first', async () => {
    h.service.createProject({ number: '24001', name: 'A' }, { actor: { type: 'user' } })
    h.service.createProject({ number: '24002', name: 'B' }, { actor: { type: 'user' } })

    const res = await h.app.inject({ method: 'GET', url: '/api/v1/projects' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { projects: Array<{ number: string }> }
    expect(body.projects.map((p) => p.number)).toEqual(['24002', '24001'])
  })

  it("GET /api/v1/projects?status=active filters by status", async () => {
    const a = h.service.createProject(
      { number: '24001', name: 'A' },
      { actor: { type: 'user' } },
    )
    h.service.createProject({ number: '24002', name: 'B' }, { actor: { type: 'user' } })
    h.service.setProjectStatus(a.id, 'active', { actor: { type: 'user' } })

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/projects?status=active',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { projects: Array<{ number: string }> }
    expect(body.projects.map((p) => p.number)).toEqual(['24001'])
  })

  it('GET /api/v1/projects/:id returns the project with phases and tasks', async () => {
    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const phase = h.service.addPhase(
      { projectId: project.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    h.service.addTask(
      { projectId: project.id, phaseId: phase.id, title: 'T' },
      { actor: { type: 'user' } },
    )

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      project: { id: string }
      phases: Array<{ id: string }>
      tasks: Array<{ id: string }>
    }
    expect(body.project.id).toBe(project.id)
    expect(body.phases.map((p) => p.id)).toEqual([phase.id])
    expect(body.tasks).toHaveLength(1)
  })

  it('GET /api/v1/projects/:id returns 404 for unknown id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/projects/no-such',
    })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH /api/v1/projects/:id/status transitions and returns updated row', async () => {
    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}/status`,
      payload: { status: 'active' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { project: { status: string } }
    expect(body.project.status).toBe('active')
  })

  it('POST /api/v1/projects/:id/phases creates a phase', async () => {
    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/phases`,
      payload: { name: 'SD' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { phase: { id: string; name: string; position: number } }
    expect(body.phase.name).toBe('SD')
    expect(body.phase.position).toBe(0)
  })

  it('POST /api/v1/projects/:id/tasks creates a task; 400 if phaseId missing or wrong project', async () => {
    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const phase = h.service.addPhase(
      { projectId: project.id, name: 'SD' },
      { actor: { type: 'user' } },
    )

    const ok = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/tasks`,
      payload: { phaseId: phase.id, title: 'Draft' },
    })
    expect(ok.statusCode).toBe(201)

    const missing = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/tasks`,
      payload: { title: 'No phase' },
    })
    expect(missing.statusCode).toBe(400)
  })
})

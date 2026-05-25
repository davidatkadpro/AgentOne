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

async function seedProjectAndTask(h: Harness): Promise<{ projectId: string; taskId: string }> {
  const projectRes = await h.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { number: '26100', name: 'Original' },
  })
  const projectId = (projectRes.json() as { project: { id: string } }).project.id
  const phaseRes = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/phases`,
    payload: { name: 'P1' },
  })
  const phaseId = (phaseRes.json() as { phase: { id: string } }).phase.id
  const taskRes = await h.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/tasks`,
    payload: { phaseId, title: 'T1' },
  })
  const taskId = (taskRes.json() as { task: { id: string } }).task.id
  return { projectId, taskId }
}

describe('PATCH /api/projects/:id', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await disposeHarness(h)
  })

  it('updates name, client, description and returns the new row', async () => {
    const { projectId } = await seedProjectAndTask(h)
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      payload: { name: 'Renamed', client: 'ACME', description: 'desc' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { project: { name: string; client: string; description: string } }
    expect(body.project.name).toBe('Renamed')
    expect(body.project.client).toBe('ACME')
    expect(body.project.description).toBe('desc')
  })

  it('rejects empty body with 400', async () => {
    const { projectId } = await seedProjectAndTask(h)
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for an unknown project id', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/projects/missing',
      payload: { name: 'x' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('PATCH /api/tasks/:id — depth fields', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await disposeHarness(h)
  })

  it('round-trips schedule, priority, and time fields', async () => {
    const { taskId } = await seedProjectAndTask(h)
    const start = Date.UTC(2026, 5, 1)
    const due = Date.UTC(2026, 5, 10)
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: {
        startDate: start,
        dueDate: due,
        estimatedMinutes: 90,
        spentMinutes: 30,
        priority: 'high',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      task: {
        startDate: number
        dueDate: number
        estimatedMinutes: number
        spentMinutes: number
        priority: string
      }
    }
    expect(body.task.startDate).toBe(start)
    expect(body.task.dueDate).toBe(due)
    expect(body.task.estimatedMinutes).toBe(90)
    expect(body.task.spentMinutes).toBe(30)
    expect(body.task.priority).toBe('high')
  })

  it('rejects an out-of-range estimatedMinutes', async () => {
    const { taskId } = await seedProjectAndTask(h)
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { estimatedMinutes: 999_999_999 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unknown priority', async () => {
    const { taskId } = await seedProjectAndTask(h)
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { priority: 'pizza' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('Task file routes', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await disposeHarness(h)
  })

  it('POST attaches a file and GET lists it', async () => {
    const { taskId } = await seedProjectAndTask(h)
    const post = await h.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/files`,
      payload: { filePath: 'in/site/scope.md', label: 'Scope' },
    })
    expect(post.statusCode).toBe(201)
    const get = await h.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/files`,
    })
    expect(get.statusCode).toBe(200)
    const body = get.json() as { files: Array<{ filePath: string; label: string }> }
    expect(body.files.length).toBe(1)
    expect(body.files[0]?.filePath).toBe('in/site/scope.md')
    expect(body.files[0]?.label).toBe('Scope')
  })

  it('rejects an unsafe filePath (absolute / traversal)', async () => {
    const { taskId } = await seedProjectAndTask(h)
    const abs = await h.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/files`,
      payload: { filePath: '/etc/passwd' },
    })
    expect(abs.statusCode).toBe(400)
    const traverse = await h.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/files`,
      payload: { filePath: '../escape.md' },
    })
    expect(traverse.statusCode).toBe(400)
  })

  it('DELETE removes the file', async () => {
    const { taskId } = await seedProjectAndTask(h)
    await h.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/files`,
      payload: { filePath: 'a.md' },
    })
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}/files`,
      payload: { filePath: 'a.md' },
    })
    expect(del.statusCode).toBe(200)
    const get = await h.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/files`,
    })
    const body = get.json() as { files: unknown[] }
    expect(body.files.length).toBe(0)
  })

  it('GET project detail includes taskFiles', async () => {
    const { projectId, taskId } = await seedProjectAndTask(h)
    await h.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/files`,
      payload: { filePath: 'a.md' },
    })
    const res = await h.app.inject({ method: 'GET', url: `/api/projects/${projectId}` })
    const body = res.json() as { taskFiles: Array<{ taskId: string; filePath: string }> }
    expect(body.taskFiles.length).toBe(1)
    expect(body.taskFiles[0]?.taskId).toBe(taskId)
  })
})

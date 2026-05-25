import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog, type AuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import {
  createProjectsService,
  type ProjectsService,
} from '../modules/projects/src/service.js'
import { registerProjectsRoutes } from '../modules/projects/src/routes.js'

interface Harness {
  db: Db
  service: ProjectsService
  audit: AuditLog
  app: FastifyInstance
  storageRoot: string
}

async function newHarness(opts: { storageRoot?: string } = {}): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  const audit = createAuditLog(db)
  const service = createProjectsService({
    db,
    eventBus: new EventBus(),
    audit,
  })
  const app = Fastify({ logger: false })
  const storageRoot = opts.storageRoot ?? mkdtempSync(join(tmpdir(), 'projects-phase2-'))
  await registerProjectsRoutes(app, { service, audit, storageRoot })
  await app.ready()
  return { db, service, audit, app, storageRoot }
}

async function disposeHarness(h: Harness): Promise<void> {
  await h.app.close()
  h.db.close()
  try {
    rmSync(h.storageRoot, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

describe('Projects routes — Phase 2 additions', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await disposeHarness(h)
  })

  // ── P2P1: /api/projects/* aliases ────────────────────────────────────────
  it('P2P1: /api/projects responds identically to /api/v1/projects', async () => {
    h.service.createProject({ number: '24001', name: 'A' }, { actor: { type: 'user' } })

    const v1 = await h.app.inject({ method: 'GET', url: '/api/v1/projects' })
    const v2 = await h.app.inject({ method: 'GET', url: '/api/projects' })
    expect(v1.statusCode).toBe(200)
    expect(v2.statusCode).toBe(200)
    expect(v2.json()).toEqual(v1.json())
  })

  it('P2P1: POST /api/projects creates a project (no /v1 prefix)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { number: '24001', name: 'Riverside' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { project: { number: string } }
    expect(body.project.number).toBe('24001')
  })

  // ── P2P10: next-number ───────────────────────────────────────────────────
  it('P2P10: GET /api/projects/next-number returns YY001 with no projects', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/projects/next-number' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { number: string }
    const yy = String(new Date().getFullYear() % 100).padStart(2, '0')
    expect(body.number).toBe(`${yy}001`)
  })

  it('P2P10: next-number advances to YY002 after YY001', async () => {
    const yy = String(new Date().getFullYear() % 100).padStart(2, '0')
    h.service.createProject(
      { number: `${yy}001`, name: 'A' },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({ method: 'GET', url: '/api/projects/next-number' })
    const body = res.json() as { number: string }
    expect(body.number).toBe(`${yy}002`)
  })

  it('P2P10: next-number skips over non-sequential numbers (advances past max)', async () => {
    const yy = String(new Date().getFullYear() % 100).padStart(2, '0')
    h.service.createProject(
      { number: `${yy}007`, name: 'A' },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({ method: 'GET', url: '/api/projects/next-number' })
    const body = res.json() as { number: string }
    expect(body.number).toBe(`${yy}008`)
  })

  // ── P2P2: PATCH /api/tasks/:id ───────────────────────────────────────────
  it('P2P2: PATCH /api/tasks/:id renames a task and emits task.updated audit row', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const ph = h.service.addPhase(
      { projectId: p.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const t = h.service.addTask(
      { projectId: p.id, phaseId: ph.id, title: 'Draft' },
      { actor: { type: 'user' } },
    )

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t.id}`,
      payload: { title: 'Draft v2' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { task: { title: string; id: string } }
    expect(body.task.title).toBe('Draft v2')

    const activity = h.audit.listByProject(p.id)
    expect(activity.entries.some((e) => e.action === 'task.updated')).toBe(true)
  })

  it('P2P2: PATCH status transitions to completed emit task.completed audit', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const ph = h.service.addPhase(
      { projectId: p.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const t = h.service.addTask(
      { projectId: p.id, phaseId: ph.id, title: 'Draft' },
      { actor: { type: 'user' } },
    )

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t.id}`,
      payload: { status: 'completed' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().task.status).toBe('completed')

    const activity = h.audit.listByProject(p.id)
    expect(activity.entries.some((e) => e.action === 'task.completed')).toBe(true)
  })

  it('P2P2: PATCH /api/tasks/:id 404 for unknown id', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/tasks/no-such`,
      payload: { title: 'X' },
    })
    expect(res.statusCode).toBe(404)
  })

  // ── P2P3: PATCH /api/phases/:id ──────────────────────────────────────────
  it('P2P3: PATCH /api/phases/:id renames a phase', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const ph = h.service.addPhase(
      { projectId: p.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/phases/${ph.id}`,
      payload: { name: 'Schematic Design' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { phase: { name: string } }
    expect(body.phase.name).toBe('Schematic Design')
  })

  it('P2P3: PATCH phase status to completed records phase.completed', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const ph = h.service.addPhase(
      { projectId: p.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/phases/${ph.id}`,
      payload: { status: 'completed' },
    })
    expect(res.statusCode).toBe(200)

    const activity = h.audit.listByProject(p.id)
    expect(activity.entries.some((e) => e.action === 'phase.completed')).toBe(true)
  })

  // ── P2P4: dependency routes ──────────────────────────────────────────────
  it('P2P4: POST /api/tasks/:id/dependencies adds a dependency', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const ph = h.service.addPhase(
      { projectId: p.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const a = h.service.addTask(
      { projectId: p.id, phaseId: ph.id, title: 'A' },
      { actor: { type: 'user' } },
    )
    const b = h.service.addTask(
      { projectId: p.id, phaseId: ph.id, title: 'B' },
      { actor: { type: 'user' } },
    )

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/tasks/${a.id}/dependencies`,
      payload: { dependsOnTaskId: b.id },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      dependency: { taskId: a.id, dependsOnTaskId: b.id },
    })

    // Reflected in GET /api/projects/:id
    const detail = await h.app.inject({ method: 'GET', url: `/api/projects/${p.id}` })
    const body = detail.json() as { dependencies: Array<{ taskId: string; dependsOnTaskId: string }> }
    expect(body.dependencies).toEqual([{ taskId: a.id, dependsOnTaskId: b.id }])
  })

  it('P2P4: cycle attempt returns 409 TASK_DEPENDENCY_CYCLE', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const ph = h.service.addPhase(
      { projectId: p.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const a = h.service.addTask(
      { projectId: p.id, phaseId: ph.id, title: 'A' },
      { actor: { type: 'user' } },
    )
    const b = h.service.addTask(
      { projectId: p.id, phaseId: ph.id, title: 'B' },
      { actor: { type: 'user' } },
    )

    h.service.setDependency({ taskId: a.id, dependsOnTaskId: b.id }, { actor: { type: 'user' } })
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/tasks/${b.id}/dependencies`,
      payload: { dependsOnTaskId: a.id },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('TASK_DEPENDENCY_CYCLE')
  })

  it('P2P4: DELETE /api/tasks/:id/dependencies/:dependsOnTaskId removes a dependency', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const ph = h.service.addPhase(
      { projectId: p.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const a = h.service.addTask(
      { projectId: p.id, phaseId: ph.id, title: 'A' },
      { actor: { type: 'user' } },
    )
    const b = h.service.addTask(
      { projectId: p.id, phaseId: ph.id, title: 'B' },
      { actor: { type: 'user' } },
    )
    h.service.setDependency({ taskId: a.id, dependsOnTaskId: b.id }, { actor: { type: 'user' } })

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${a.id}/dependencies/${b.id}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const detail = await h.app.inject({ method: 'GET', url: `/api/projects/${p.id}` })
    const body = detail.json() as { dependencies: unknown[] }
    expect(body.dependencies).toEqual([])
  })

  // ── P2P5 + P2P6: activity stream ─────────────────────────────────────────
  it('P2P6: GET /api/projects/:id/activity lists rows scoped to that project', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const ph = h.service.addPhase(
      { projectId: p.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    h.service.addTask(
      { projectId: p.id, phaseId: ph.id, title: 'T' },
      { actor: { type: 'user' } },
    )
    // Other project — should not appear.
    const q = h.service.createProject(
      { number: '24002', name: 'Q' },
      { actor: { type: 'user' } },
    )

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/activity`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      entries: Array<{ action: string; targetId: string }>
      hasMore: boolean
    }
    const actions = body.entries.map((e) => e.action).sort()
    expect(actions).toEqual(['phase.created', 'project.created', 'task.created'])
    expect(body.entries.every((e) => e.targetId !== q.id)).toBe(true)
    expect(body.hasMore).toBe(false)
  })

  it('P2P6: activity supports limit + offset pagination', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const ph = h.service.addPhase(
      { projectId: p.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    for (let i = 0; i < 4; i++) {
      h.service.addTask(
        { projectId: p.id, phaseId: ph.id, title: `T${i}` },
        { actor: { type: 'user' } },
      )
    }

    const page1 = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/activity?limit=2&offset=0`,
    })
    const body1 = page1.json() as { entries: unknown[]; hasMore: boolean }
    expect(body1.entries).toHaveLength(2)
    expect(body1.hasMore).toBe(true)

    const page2 = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/activity?limit=10&offset=2`,
    })
    const body2 = page2.json() as { entries: unknown[]; hasMore: boolean }
    expect(body2.entries.length).toBeGreaterThan(0)
    expect(body2.hasMore).toBe(false)
  })

  it('P2P6: activity returns 404 for unknown project', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/projects/no-such/activity`,
    })
    expect(res.statusCode).toBe(404)
  })

  // ── P2P7: scope ──────────────────────────────────────────────────────────
  it('P2P7: GET /api/projects/:id/scope returns null fields when no scope file exists', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/scope`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ path: null, markdown: null, generatedAt: null })
  })

  it('P2P7: scope returns the newest scope.md when planted', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'Riverside' },
      { actor: { type: 'user' } },
    )
    const inDir = join(h.storageRoot, p.folderPath!, 'in')
    await mkdir(join(inDir, '241101 - kickoff'), { recursive: true })
    await writeFile(join(inDir, '241101 - kickoff', 'scope.md'), '# Old', 'utf-8')
    // Delay so mtimes differ.
    await new Promise((r) => setTimeout(r, 15))
    await mkdir(join(inDir, '241108 - rfi'), { recursive: true })
    await writeFile(join(inDir, '241108 - rfi', 'scope.md'), '# New scope', 'utf-8')

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/scope`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { path: string; markdown: string; generatedAt: string }
    expect(body.markdown).toBe('# New scope')
    expect(body.path).toContain('241108 - rfi/scope.md')
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('P2P7: scope returns 404 for unknown project', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/projects/no-such/scope`,
    })
    expect(res.statusCode).toBe(404)
  })

  // ── P2P8: files ──────────────────────────────────────────────────────────
  it('P2P8: GET /api/projects/:id/files lists in/ and drafts/ entries', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'Riverside' },
      { actor: { type: 'user' } },
    )
    const folder = join(h.storageRoot, p.folderPath!)
    await mkdir(join(folder, 'in', '241108 - rfi'), { recursive: true })
    await writeFile(join(folder, 'in', 'kickoff.eml'), 'msg', 'utf-8')
    await mkdir(join(folder, 'drafts'), { recursive: true })
    await writeFile(join(folder, 'drafts', 'estimate.md'), '# estimate', 'utf-8')

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/files`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      rootPath: string
      entries: Array<{ relativePath: string; kind: 'file' | 'directory' }>
    }
    // Response now returns the storage-relative path (no absolute host
    // path leak). Verify it matches the project's folder_path verbatim —
    // clients combine this with `relativePath` when addressing files.
    expect(body.rootPath).toBe(p.folderPath)
    const rels = body.entries.map((e) => e.relativePath).sort()
    expect(rels).toEqual([
      'drafts/estimate.md',
      'in/241108 - rfi',
      'in/kickoff.eml',
    ])
    const dir = body.entries.find((e) => e.relativePath === 'in/241108 - rfi')
    expect(dir?.kind).toBe('directory')
  })

  it('P2P8: files returns empty entries when subfolders are missing', async () => {
    const p = h.service.createProject(
      { number: '24001', name: 'NoFiles' },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/files`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().entries).toEqual([])
  })

  // P2P9: GET /api/projects/:id/budget moved to the invoicing module in Phase 5
  // — see tests/invoicing-routes.test.ts for the canonical InvoiceBudget shape.
})

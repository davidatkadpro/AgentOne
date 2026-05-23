import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog, type AuditLog } from '@/modules/audit-log.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import {
  createProjectsService,
  DuplicateProjectNumberError,
  type ProjectsService,
} from '../modules/projects/src/service.js'

interface Harness {
  db: Db
  bus: EventBus
  audit: AuditLog
  service: ProjectsService
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const sql = readFileSync(
    join(process.cwd(), 'modules', 'projects', 'schema', '001_init.sql'),
    'utf-8',
  )
  applyModuleMigrations(db, 'projects', [{ version: 1, name: '001_init', sql }])
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const service = createProjectsService({ db, eventBus: bus, audit })
  return { db, bus, audit, service }
}

function disposeHarness(h: Harness): void {
  h.db.close()
}

describe('ProjectsService.createProject — tracer', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('inserts a project row with default status="pending" and timestamps', () => {
    const project = h.service.createProject(
      {
        number: '24001',
        name: 'Riverside Reno',
        client: 'Owner LLC',
        description: 'Single-family residence renovation',
      },
      { actor: { type: 'user' } },
    )

    expect(project.id).toBeTruthy()
    expect(project.number).toBe('24001')
    expect(project.name).toBe('Riverside Reno')
    expect(project.client).toBe('Owner LLC')
    expect(project.description).toBe('Single-family residence renovation')
    expect(project.status).toBe('pending')
    expect(project.createdAt).toBeGreaterThan(0)
    expect(project.updatedAt).toBeGreaterThan(0)
    expect(project.completedAt).toBeNull()
    expect(project.metadata).toEqual({})

    const fetched = h.service.getProject(project.id)
    expect(fetched).toEqual(project)
  })

  it('records an audit row tagged with the actor and emits project.created', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('project.created', (e) => {
      captured.push(e)
    })

    const project = h.service.createProject(
      { number: '24002', name: 'Maple Addition' },
      { actor: { type: 'agent', sessionId: 'sess-1' } },
    )
    // Allow event-bus microtasks to settle.
    await new Promise((r) => setImmediate(r))

    const auditEntries = h.audit.listByEntity('project', project.id)
    expect(auditEntries).toHaveLength(1)
    expect(auditEntries[0].action).toBe('project.created')
    expect(auditEntries[0].actor).toEqual({ type: 'agent', sessionId: 'sess-1' })
    expect(auditEntries[0].module).toBe('projects')

    expect(captured).toHaveLength(1)
    const evt = captured[0]
    if (evt.type === 'project.created') {
      expect(evt.projectId).toBe(project.id)
      expect(evt.number).toBe('24002')
    }
  })

  it('throws DuplicateProjectNumberError when number is already used', async () => {
    h.service.createProject(
      { number: '24001', name: 'First' },
      { actor: { type: 'user' } },
    )

    const captured: AgentEvent[] = []
    h.bus.on('project.created', (e) => {
      captured.push(e)
    })

    expect(() =>
      h.service.createProject(
        { number: '24001', name: 'Second' },
        { actor: { type: 'user' } },
      ),
    ).toThrow(DuplicateProjectNumberError)

    await new Promise((r) => setImmediate(r))

    // No second row, no extra event, no extra audit entry for the second number.
    const rows = h.db
      .prepare("SELECT COUNT(*) as n FROM project WHERE number = '24001'")
      .get() as { n: number }
    expect(rows.n).toBe(1)
    expect(captured).toHaveLength(0)
  })
})

describe('ProjectsService.listProjects', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('returns projects newest-first by createdAt', () => {
    const a = h.service.createProject({ number: '24001', name: 'A' }, { actor: { type: 'user' } })
    const b = h.service.createProject({ number: '24002', name: 'B' }, { actor: { type: 'user' } })
    const c = h.service.createProject({ number: '24003', name: 'C' }, { actor: { type: 'user' } })

    const list = h.service.listProjects()
    expect(list.map((p) => p.id)).toEqual([c.id, b.id, a.id])
  })

  it('filters by status when a status array is provided', () => {
    const active = h.service.createProject(
      { number: '24001', name: 'Active' },
      { actor: { type: 'user' } },
    )
    h.service.createProject({ number: '24002', name: 'Pending' }, { actor: { type: 'user' } })
    h.db.prepare("UPDATE project SET status = 'active' WHERE id = ?").run(active.id)

    const onlyActive = h.service.listProjects({ status: ['active'] })
    expect(onlyActive.map((p) => p.number)).toEqual(['24001'])
  })
})

describe('ProjectsService.addPhase', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('creates a phase scoped to a project with auto-incrementing position', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('phase.created', (e) => {
      captured.push(e)
    })
    const project = h.service.createProject(
      { number: '24001', name: 'Riverside' },
      { actor: { type: 'user' } },
    )

    const sd = h.service.addPhase(
      { projectId: project.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const dd = h.service.addPhase(
      { projectId: project.id, name: 'DD' },
      { actor: { type: 'user' } },
    )
    await new Promise((r) => setImmediate(r))

    expect(sd.position).toBe(0)
    expect(dd.position).toBe(1)
    expect(sd.projectId).toBe(project.id)
    expect(sd.status).toBe('pending')

    const phases = h.service.listPhases(project.id)
    expect(phases.map((p) => p.id)).toEqual([sd.id, dd.id])

    expect(captured).toHaveLength(2)
    expect(captured.map((e) => (e as { phaseId: string }).phaseId)).toEqual([sd.id, dd.id])

    const auditA = h.audit.listByEntity('phase', sd.id)
    expect(auditA[0]?.action).toBe('phase.created')
  })

  it('throws when projectId does not exist', () => {
    expect(() =>
      h.service.addPhase(
        { projectId: 'no-such-project', name: 'SD' },
        { actor: { type: 'user' } },
      ),
    ).toThrow()
  })
})

describe('ProjectsService.addTask', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('creates a task under a phase, default status="pending", and audits + emits', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('task.created', (e) => {
      captured.push(e)
    })

    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const phase = h.service.addPhase(
      { projectId: project.id, name: 'SD' },
      { actor: { type: 'user' } },
    )

    const task = h.service.addTask(
      {
        projectId: project.id,
        phaseId: phase.id,
        title: 'Draft floor plan',
        description: 'Block out room sizes',
        assigneeProfile: 'drafter',
      },
      { actor: { type: 'agent', sessionId: 'sess-1' } },
    )
    await new Promise((r) => setImmediate(r))

    expect(task.title).toBe('Draft floor plan')
    expect(task.status).toBe('pending')
    expect(task.phaseId).toBe(phase.id)
    expect(task.projectId).toBe(project.id)
    expect(task.parentTaskId).toBeNull()
    expect(task.assigneeProfile).toBe('drafter')
    expect(task.position).toBe(0)

    const tasks = h.service.listTasks(project.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe(task.id)

    expect(captured).toHaveLength(1)
    const evt = captured[0]
    if (evt.type === 'task.created') {
      expect(evt.taskId).toBe(task.id)
      expect(evt.phaseId).toBe(phase.id)
    }

    const audit = h.audit.listByEntity('task', task.id)
    expect(audit[0]?.action).toBe('task.created')
  })

  it('rejects a task with a phaseId that does not belong to the given project', () => {
    const p1 = h.service.createProject(
      { number: '24001', name: 'P1' },
      { actor: { type: 'user' } },
    )
    const p2 = h.service.createProject(
      { number: '24002', name: 'P2' },
      { actor: { type: 'user' } },
    )
    const phaseOfP2 = h.service.addPhase(
      { projectId: p2.id, name: 'SD' },
      { actor: { type: 'user' } },
    )

    expect(() =>
      h.service.addTask(
        {
          projectId: p1.id,
          phaseId: phaseOfP2.id,
          title: 'Mismatched task',
        },
        { actor: { type: 'user' } },
      ),
    ).toThrow()
  })
})

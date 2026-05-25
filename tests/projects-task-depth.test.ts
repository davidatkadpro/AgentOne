import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog, type AuditLog } from '@/modules/audit-log.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import { NotFoundError } from '@/errors/domain.js'
import {
  createProjectsService,
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
  applyAllMigrationsForModule(db, 'projects')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const service = createProjectsService({ db, eventBus: bus, audit })
  return { db, bus, audit, service }
}

function disposeHarness(h: Harness): void {
  h.db.close()
}

function seedProject(h: Harness): { projectId: string; phaseId: string } {
  const project = h.service.createProject(
    { number: '26001', name: 'Initial' },
    { actor: { type: 'user' } },
  )
  const phase = h.service.addPhase(
    { projectId: project.id, name: 'Phase 1' },
    { actor: { type: 'user' } },
  )
  return { projectId: project.id, phaseId: phase.id }
}

describe('ProjectsService.updateProject', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('updates name, client, and description independently', () => {
    const { projectId } = seedProject(h)
    const updated = h.service.updateProject(
      { projectId, name: 'Renamed' },
      { actor: { type: 'user' } },
    )
    expect(updated.name).toBe('Renamed')
    expect(updated.client).toBeNull()

    const withClient = h.service.updateProject(
      { projectId, client: 'ACME' },
      { actor: { type: 'user' } },
    )
    expect(withClient.name).toBe('Renamed')
    expect(withClient.client).toBe('ACME')

    const cleared = h.service.updateProject(
      { projectId, client: null, description: 'D' },
      { actor: { type: 'user' } },
    )
    expect(cleared.client).toBeNull()
    expect(cleared.description).toBe('D')
  })

  it('emits project.updated and writes an audit row', () => {
    const { projectId } = seedProject(h)
    const events: AgentEvent[] = []
    h.bus.onAny((e) => {
      events.push(e)
    })
    h.service.updateProject(
      { projectId, name: 'New' },
      { actor: { type: 'user' } },
    )
    expect(events.some((e) => e.type === 'project.updated')).toBe(true)
    const entries = h.audit.listByProject(projectId).entries
    expect(entries.some((e) => e.action === 'project.updated')).toBe(true)
  })

  it('throws NotFoundError for an unknown project', () => {
    expect(() =>
      h.service.updateProject(
        { projectId: 'missing', name: 'x' },
        { actor: { type: 'user' } },
      ),
    ).toThrow(NotFoundError)
  })
})

describe('ProjectsService — task depth columns', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('addTask defaults depth fields to null / 0 / normal', () => {
    const { projectId, phaseId } = seedProject(h)
    const task = h.service.addTask(
      { projectId, phaseId, title: 'T' },
      { actor: { type: 'user' } },
    )
    expect(task.startDate).toBeNull()
    expect(task.dueDate).toBeNull()
    expect(task.estimatedMinutes).toBeNull()
    expect(task.spentMinutes).toBe(0)
    expect(task.priority).toBe('normal')
  })

  it('addTask round-trips explicit depth fields', () => {
    const { projectId, phaseId } = seedProject(h)
    const start = Date.UTC(2026, 4, 1)
    const due = Date.UTC(2026, 4, 8)
    const task = h.service.addTask(
      {
        projectId,
        phaseId,
        title: 'T',
        startDate: start,
        dueDate: due,
        estimatedMinutes: 120,
        priority: 'high',
      },
      { actor: { type: 'user' } },
    )
    expect(task.startDate).toBe(start)
    expect(task.dueDate).toBe(due)
    expect(task.estimatedMinutes).toBe(120)
    expect(task.priority).toBe('high')
    expect(h.service.getTask(task.id)?.priority).toBe('high')
  })

  it('updateTask can change priority and clear due_date independently', () => {
    const { projectId, phaseId } = seedProject(h)
    const t = h.service.addTask(
      { projectId, phaseId, title: 'T', dueDate: 1, priority: 'urgent' },
      { actor: { type: 'user' } },
    )
    const updated = h.service.updateTask(
      { taskId: t.id, dueDate: null, priority: 'low' },
      { actor: { type: 'user' } },
    )
    expect(updated.dueDate).toBeNull()
    expect(updated.priority).toBe('low')
  })

  it('updateTask increments spent_minutes', () => {
    const { projectId, phaseId } = seedProject(h)
    const t = h.service.addTask(
      { projectId, phaseId, title: 'T', estimatedMinutes: 60 },
      { actor: { type: 'user' } },
    )
    const u = h.service.updateTask(
      { taskId: t.id, spentMinutes: 30 },
      { actor: { type: 'user' } },
    )
    expect(u.spentMinutes).toBe(30)
    expect(u.estimatedMinutes).toBe(60)
  })

  it('rejects invalid priority at the DB boundary', () => {
    const { projectId, phaseId } = seedProject(h)
    const t = h.service.addTask(
      { projectId, phaseId, title: 'T' },
      { actor: { type: 'user' } },
    )
    expect(() =>
      h.service.updateTask(
        // Casting because the type system forbids this — we want to prove
        // the DB CHECK catches it if a route ever leaks through.
        { taskId: t.id, priority: 'pizza' as unknown as 'low' },
        { actor: { type: 'user' } },
      ),
    ).toThrow()
  })
})

describe('ProjectsService — task file links', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('attach → list → detach round-trips', () => {
    const { projectId, phaseId } = seedProject(h)
    const t = h.service.addTask(
      { projectId, phaseId, title: 'T' },
      { actor: { type: 'user' } },
    )
    const file = h.service.attachTaskFile(
      { taskId: t.id, filePath: 'in/site/scope.md', label: 'Scope' },
      { actor: { type: 'user' } },
    )
    expect(file.filePath).toBe('in/site/scope.md')
    expect(file.label).toBe('Scope')

    const files = h.service.listTaskFiles(t.id)
    expect(files.length).toBe(1)

    h.service.detachTaskFile(
      { taskId: t.id, filePath: 'in/site/scope.md' },
      { actor: { type: 'user' } },
    )
    expect(h.service.listTaskFiles(t.id).length).toBe(0)
  })

  it('attaching the same path twice replaces the label (upsert)', () => {
    const { projectId, phaseId } = seedProject(h)
    const t = h.service.addTask(
      { projectId, phaseId, title: 'T' },
      { actor: { type: 'user' } },
    )
    h.service.attachTaskFile(
      { taskId: t.id, filePath: 'a.md', label: 'first' },
      { actor: { type: 'user' } },
    )
    h.service.attachTaskFile(
      { taskId: t.id, filePath: 'a.md', label: 'second' },
      { actor: { type: 'user' } },
    )
    const files = h.service.listTaskFiles(t.id)
    expect(files.length).toBe(1)
    expect(files[0]?.label).toBe('second')
  })

  it('cascades on task delete', () => {
    const { projectId, phaseId } = seedProject(h)
    const t = h.service.addTask(
      { projectId, phaseId, title: 'T' },
      { actor: { type: 'user' } },
    )
    h.service.attachTaskFile(
      { taskId: t.id, filePath: 'a.md' },
      { actor: { type: 'user' } },
    )
    h.db.prepare('DELETE FROM task WHERE id = ?').run(t.id)
    expect(h.service.listTaskFiles(t.id).length).toBe(0)
  })

  it('emits task.file_attached / task.file_detached events', () => {
    const { projectId, phaseId } = seedProject(h)
    const t = h.service.addTask(
      { projectId, phaseId, title: 'T' },
      { actor: { type: 'user' } },
    )
    const events: AgentEvent[] = []
    h.bus.onAny((e) => {
      events.push(e)
    })
    h.service.attachTaskFile(
      { taskId: t.id, filePath: 'a.md' },
      { actor: { type: 'user' } },
    )
    h.service.detachTaskFile(
      { taskId: t.id, filePath: 'a.md' },
      { actor: { type: 'user' } },
    )
    const types = events.map((e) => e.type)
    expect(types).toContain('task.file_attached')
    expect(types).toContain('task.file_detached')
  })

  it('throws NotFoundError when attaching to an unknown task', () => {
    expect(() =>
      h.service.attachTaskFile(
        { taskId: 'missing', filePath: 'a.md' },
        { actor: { type: 'user' } },
      ),
    ).toThrow(NotFoundError)
  })
})

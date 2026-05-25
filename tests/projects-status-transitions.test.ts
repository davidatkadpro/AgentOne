import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog, type AuditLog } from '@/modules/audit-log.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
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

describe('ProjectsService.setProjectStatus', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('transitions a project status and bumps updatedAt', () => {
    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const before = project.updatedAt

    // Wait at least 1ms so the timestamp can actually advance.
    const start = Date.now()
    while (Date.now() === start) {
      /* spin */
    }
    h.service.setProjectStatus(project.id, 'active', { actor: { type: 'user' } })

    const fetched = h.service.getProject(project.id)
    expect(fetched?.status).toBe('active')
    expect(fetched?.updatedAt).toBeGreaterThan(before)
    expect(fetched?.completedAt).toBeNull()
  })

  it("sets completedAt and emits project.completed when transitioning to 'completed'", async () => {
    const captured: AgentEvent[] = []
    h.bus.on('project.completed', (e) => {
      captured.push(e)
    })

    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    h.service.setProjectStatus(project.id, 'completed', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))

    const fetched = h.service.getProject(project.id)
    expect(fetched?.status).toBe('completed')
    expect(fetched?.completedAt).not.toBeNull()
    expect(captured).toHaveLength(1)
  })

  it("emits project.updated on non-terminal transitions", async () => {
    const captured: AgentEvent[] = []
    h.bus.on('project.updated', (e) => {
      captured.push(e)
    })

    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    h.service.setProjectStatus(project.id, 'active', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))

    expect(captured).toHaveLength(1)
  })

  it('throws on unknown project id', () => {
    expect(() =>
      h.service.setProjectStatus('nope', 'active', { actor: { type: 'user' } }),
    ).toThrow()
  })
})

describe('ProjectsService.setTaskStatus', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  function seedTask(): { projectId: string; taskId: string } {
    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const phase = h.service.addPhase(
      { projectId: project.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const task = h.service.addTask(
      { projectId: project.id, phaseId: phase.id, title: 'T' },
      { actor: { type: 'user' } },
    )
    return { projectId: project.id, taskId: task.id }
  }

  it("sets task status='completed' and emits task.completed", async () => {
    const { projectId, taskId } = seedTask()
    const captured: AgentEvent[] = []
    h.bus.on('task.completed', (e) => {
      captured.push(e)
    })

    h.service.setTaskStatus(taskId, 'completed', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))

    const [task] = h.service.listTasks(projectId)
    expect(task.status).toBe('completed')
    expect(task.completedAt).not.toBeNull()
    expect(captured).toHaveLength(1)
  })

  it("emits task.blocked with the reason when transitioning to 'blocked'", async () => {
    const { projectId, taskId } = seedTask()
    const captured: AgentEvent[] = []
    h.bus.on('task.blocked', (e) => {
      captured.push(e)
    })

    h.service.setTaskStatus(taskId, 'blocked', {
      actor: { type: 'user' },
      reason: 'Waiting on owner sign-off',
    })
    await new Promise((r) => setImmediate(r))

    const [task] = h.service.listTasks(projectId)
    expect(task.status).toBe('blocked')
    expect(captured).toHaveLength(1)
    const evt = captured[0]
    if (evt.type === 'task.blocked') {
      expect(evt.reason).toBe('Waiting on owner sign-off')
    }
  })

  it("emits task.updated on non-terminal transitions", async () => {
    const { taskId } = seedTask()
    const captured: AgentEvent[] = []
    h.bus.on('task.updated', (e) => {
      captured.push(e)
    })

    h.service.setTaskStatus(taskId, 'active', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))

    expect(captured).toHaveLength(1)
  })
})

describe('ProjectsService.setPhaseStatus', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it("sets phase status and emits phase.completed on completion", async () => {
    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const phase = h.service.addPhase(
      { projectId: project.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const captured: AgentEvent[] = []
    h.bus.on('phase.completed', (e) => {
      captured.push(e)
    })

    h.service.setPhaseStatus(phase.id, 'completed', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))

    const [fetched] = h.service.listPhases(project.id)
    expect(fetched.status).toBe('completed')
    expect(fetched.completedAt).not.toBeNull()
    expect(captured).toHaveLength(1)
  })
})

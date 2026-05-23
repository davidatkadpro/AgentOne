import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog, type AuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import {
  createProjectsService,
  TaskDependencyCycleError,
  type ProjectsService,
  type Task,
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

function seedTwoTasks(service: ProjectsService): { a: Task; b: Task } {
  const project = service.createProject(
    { number: '24001', name: 'P' },
    { actor: { type: 'user' } },
  )
  const phase = service.addPhase(
    { projectId: project.id, name: 'SD' },
    { actor: { type: 'user' } },
  )
  const a = service.addTask(
    { projectId: project.id, phaseId: phase.id, title: 'A' },
    { actor: { type: 'user' } },
  )
  const b = service.addTask(
    { projectId: project.id, phaseId: phase.id, title: 'B' },
    { actor: { type: 'user' } },
  )
  return { a, b }
}

describe('ProjectsService — task dependencies', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('setDependency records B depends on A; getBlockers(B) returns [A]', () => {
    const { a, b } = seedTwoTasks(h.service)
    h.service.setDependency(
      { taskId: b.id, dependsOnTaskId: a.id },
      { actor: { type: 'user' } },
    )
    const blockers = h.service.getBlockers(b.id)
    expect(blockers.map((t) => t.id)).toEqual([a.id])
  })

  it('removeDependency clears the link', () => {
    const { a, b } = seedTwoTasks(h.service)
    h.service.setDependency(
      { taskId: b.id, dependsOnTaskId: a.id },
      { actor: { type: 'user' } },
    )
    h.service.removeDependency(
      { taskId: b.id, dependsOnTaskId: a.id },
      { actor: { type: 'user' } },
    )
    expect(h.service.getBlockers(b.id)).toEqual([])
  })

  it('rejects a self-dependency at the DB CHECK', () => {
    const { a } = seedTwoTasks(h.service)
    expect(() =>
      h.service.setDependency(
        { taskId: a.id, dependsOnTaskId: a.id },
        { actor: { type: 'user' } },
      ),
    ).toThrow()
  })

  it('rejects a cycle: A depends on B, then B depends on A throws TaskDependencyCycleError', () => {
    const { a, b } = seedTwoTasks(h.service)
    h.service.setDependency(
      { taskId: a.id, dependsOnTaskId: b.id },
      { actor: { type: 'user' } },
    )
    expect(() =>
      h.service.setDependency(
        { taskId: b.id, dependsOnTaskId: a.id },
        { actor: { type: 'user' } },
      ),
    ).toThrow(TaskDependencyCycleError)
  })

  it('rejects a transitive cycle: A→B→C, then C→A throws', () => {
    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const phase = h.service.addPhase(
      { projectId: project.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const a = h.service.addTask(
      { projectId: project.id, phaseId: phase.id, title: 'A' },
      { actor: { type: 'user' } },
    )
    const b = h.service.addTask(
      { projectId: project.id, phaseId: phase.id, title: 'B' },
      { actor: { type: 'user' } },
    )
    const c = h.service.addTask(
      { projectId: project.id, phaseId: phase.id, title: 'C' },
      { actor: { type: 'user' } },
    )
    h.service.setDependency(
      { taskId: a.id, dependsOnTaskId: b.id },
      { actor: { type: 'user' } },
    )
    h.service.setDependency(
      { taskId: b.id, dependsOnTaskId: c.id },
      { actor: { type: 'user' } },
    )
    expect(() =>
      h.service.setDependency(
        { taskId: c.id, dependsOnTaskId: a.id },
        { actor: { type: 'user' } },
      ),
    ).toThrow(TaskDependencyCycleError)
  })

  it('audits dependency.added and dependency.removed', () => {
    const { a, b } = seedTwoTasks(h.service)
    h.service.setDependency(
      { taskId: b.id, dependsOnTaskId: a.id },
      { actor: { type: 'user' } },
    )
    h.service.removeDependency(
      { taskId: b.id, dependsOnTaskId: a.id },
      { actor: { type: 'user' } },
    )
    const audit = h.audit.listByEntity('task', b.id)
    const actions = audit.map((e) => e.action)
    expect(actions).toContain('task.dependency_added')
    expect(actions).toContain('task.dependency_removed')
  })
})

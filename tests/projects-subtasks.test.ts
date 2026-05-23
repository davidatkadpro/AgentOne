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

function newHarness(): { db: Db; service: ProjectsService } {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const sql = readFileSync(
    join(process.cwd(), 'modules', 'projects', 'schema', '001_init.sql'),
    'utf-8',
  )
  applyModuleMigrations(db, 'projects', [{ version: 1, name: '001_init', sql }])
  const service = createProjectsService({
    db,
    eventBus: new EventBus(),
    audit: createAuditLog(db),
  })
  return { db, service }
}

describe('ProjectsService — subtasks', () => {
  let db: Db
  let service: ProjectsService
  beforeEach(() => {
    ;({ db, service } = newHarness())
  })
  afterEach(() => {
    db.close()
  })

  it('positions subtasks independently per parent', () => {
    const project = service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const phase = service.addPhase(
      { projectId: project.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const parentA = service.addTask(
      { projectId: project.id, phaseId: phase.id, title: 'A' },
      { actor: { type: 'user' } },
    )
    const parentB = service.addTask(
      { projectId: project.id, phaseId: phase.id, title: 'B' },
      { actor: { type: 'user' } },
    )

    // Subtasks of A
    const a1 = service.addTask(
      {
        projectId: project.id,
        phaseId: phase.id,
        parentTaskId: parentA.id,
        title: 'A.1',
      },
      { actor: { type: 'user' } },
    )
    const a2 = service.addTask(
      {
        projectId: project.id,
        phaseId: phase.id,
        parentTaskId: parentA.id,
        title: 'A.2',
      },
      { actor: { type: 'user' } },
    )
    // Subtask of B
    const b1 = service.addTask(
      {
        projectId: project.id,
        phaseId: phase.id,
        parentTaskId: parentB.id,
        title: 'B.1',
      },
      { actor: { type: 'user' } },
    )

    // Top-level tasks (parent_task_id NULL) keep their positions; subtasks
    // are positioned within their parent independently.
    expect(parentA.position).toBe(0)
    expect(parentB.position).toBe(1)
    expect(a1.position).toBe(0)
    expect(a2.position).toBe(1)
    expect(b1.position).toBe(0)

    expect(a1.parentTaskId).toBe(parentA.id)
    expect(b1.parentTaskId).toBe(parentB.id)
  })

  it('cascade-deletes subtasks when the parent task is deleted', () => {
    const project = service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const phase = service.addPhase(
      { projectId: project.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const parent = service.addTask(
      { projectId: project.id, phaseId: phase.id, title: 'Parent' },
      { actor: { type: 'user' } },
    )
    service.addTask(
      {
        projectId: project.id,
        phaseId: phase.id,
        parentTaskId: parent.id,
        title: 'Child',
      },
      { actor: { type: 'user' } },
    )

    db.prepare('DELETE FROM task WHERE id = ?').run(parent.id)
    expect(service.listTasks(project.id)).toEqual([])
  })
})

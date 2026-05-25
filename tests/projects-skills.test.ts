import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import type { ModuleHandle, ModuleRegistry } from '@/modules/registry.js'
import { fakeToolContext } from './fakes.js'
import {
  createProjectsService,
  type ProjectsService,
} from '../modules/projects/src/service.js'
import { handler as createProjectHandler } from '../modules/projects/skills/create-project/tools/create-project.js'
import { handler as listProjectsHandler } from '../modules/projects/skills/list-projects/tools/list-projects.js'
import { handler as addPhaseHandler } from '../modules/projects/skills/add-phase/tools/add-phase.js'
import { handler as addTaskHandler } from '../modules/projects/skills/add-task/tools/add-task.js'

interface Harness {
  db: Db
  service: ProjectsService
  modules: ModuleRegistry
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  const service = createProjectsService({
    db,
    eventBus: new EventBus(),
    audit: createAuditLog(db),
  })
  const handle: ModuleHandle = {
    name: 'projects',
    manifest: {
      name: 'projects',
      description: '',
      version: '0.1.0',
      dependsOn: [],
      frontmatter: {},
      body: '',
    },
    rootPath: '',
    status: 'active',
    service,
  }
  const modules: ModuleRegistry = {
    get: (n) => (n === 'projects' ? handle : undefined),
    getActiveService: <T>(n: string): T | undefined =>
      n === 'projects' ? (service as unknown as T) : undefined,
    list: () => [handle],
  }
  return { db, service, modules }
}

describe('Projects skills — handler tests', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('create-project creates a project via the service and returns its id + number', async () => {
    const ctx = fakeToolContext({
      sessionId: 'sess-1',
      services: { modules: h.modules },
    })
    const result = await createProjectHandler(
      { number: '24001', name: 'Riverside Reno', client: 'Owner LLC' },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { id: string; number: string }
    expect(value.number).toBe('24001')
    const project = h.service.getProject(value.id)
    expect(project?.name).toBe('Riverside Reno')
  })

  it('create-project returns a TOOL_VALIDATION error on duplicate number', async () => {
    h.service.createProject(
      { number: '24001', name: 'First' },
      { actor: { type: 'agent', sessionId: 'sess-1' } },
    )
    const ctx = fakeToolContext({
      sessionId: 'sess-1',
      services: { modules: h.modules },
    })
    const result = await createProjectHandler(
      { number: '24001', name: 'Second' },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('TOOL_VALIDATION')
    expect(result.error.message).toMatch(/24001/)
  })

  it('list-projects returns rows newest-first; supports status filter', async () => {
    const ctx = fakeToolContext({
      sessionId: 'sess-1',
      services: { modules: h.modules },
    })
    const a = h.service.createProject(
      { number: '24001', name: 'A' },
      { actor: { type: 'agent', sessionId: 'sess-1' } },
    )
    h.service.createProject(
      { number: '24002', name: 'B' },
      { actor: { type: 'agent', sessionId: 'sess-1' } },
    )
    h.service.setProjectStatus(a.id, 'active', { actor: { type: 'user' } })

    const all = await listProjectsHandler({}, ctx)
    expect(all.ok).toBe(true)
    if (!all.ok) return
    const allValue = all.value as { projects: Array<{ number: string }> }
    expect(allValue.projects.map((p) => p.number)).toEqual(['24002', '24001'])

    const onlyActive = await listProjectsHandler({ status: ['active'] }, ctx)
    expect(onlyActive.ok).toBe(true)
    if (!onlyActive.ok) return
    const activeValue = onlyActive.value as { projects: Array<{ number: string }> }
    expect(activeValue.projects.map((p) => p.number)).toEqual(['24001'])
  })

  it('add-phase creates a phase under a project', async () => {
    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const ctx = fakeToolContext({
      sessionId: 'sess-1',
      services: { modules: h.modules },
    })
    const result = await addPhaseHandler(
      { project_id: project.id, name: 'SD' },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { id: string; name: string }
    expect(value.name).toBe('SD')
    expect(h.service.listPhases(project.id)).toHaveLength(1)
  })

  it('add-task requires phase_id under the right project', async () => {
    const project = h.service.createProject(
      { number: '24001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const phase = h.service.addPhase(
      { projectId: project.id, name: 'SD' },
      { actor: { type: 'user' } },
    )
    const ctx = fakeToolContext({
      sessionId: 'sess-1',
      services: { modules: h.modules },
    })

    const ok = await addTaskHandler(
      { project_id: project.id, phase_id: phase.id, title: 'Draft' },
      ctx,
    )
    expect(ok.ok).toBe(true)
    if (!ok.ok) return

    const otherProject = h.service.createProject(
      { number: '24002', name: 'P2' },
      { actor: { type: 'user' } },
    )
    const mismatch = await addTaskHandler(
      { project_id: otherProject.id, phase_id: phase.id, title: 'Wrong' },
      ctx,
    )
    expect(mismatch.ok).toBe(false)
  })
})

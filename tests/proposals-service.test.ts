import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog, type AuditLog } from '@/modules/audit-log.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import {
  createProjectsService,
  type ProjectsService,
} from '../modules/projects/src/service.js'
import {
  createProposalsService,
  type ProposalsService,
} from '../modules/proposals/src/service.js'

interface Harness {
  db: Db
  bus: EventBus
  audit: AuditLog
  projects: ProjectsService
  proposals: ProposalsService
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  applyAllMigrationsForModule(db, 'proposals')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const projects = createProjectsService({ db, eventBus: bus, audit })
  const proposals = createProposalsService({ db, eventBus: bus, audit })
  return { db, bus, audit, projects, proposals }
}

function dispose(h: Harness): void {
  h.db.close()
}

describe('ProposalsService.createEstimate — tracer', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    dispose(h)
  })

  function makeProject(): string {
    return h.projects.createProject(
      { number: '25001', name: 'Riverside Reno' },
      { actor: { type: 'user' } },
    ).id
  }

  it('inserts a draft estimate and round-trips via getEstimate', () => {
    const projectId = makeProject()
    const estimate = h.proposals.createEstimate(
      {
        projectId,
        notes: 'Initial scope-aligned estimate',
        lines: [
          {
            kind: 'fixed',
            description: 'Permit drawings',
            qty: 1,
            unitPrice: 4500,
          },
          {
            kind: 'time_and_materials',
            description: 'Site visits',
            qty: 8,
            unit: 'hr',
            unitPrice: 165,
          },
        ],
      },
      { actor: { type: 'user' } },
    )

    expect(estimate.id).toBeTruthy()
    expect(estimate.projectId).toBe(projectId)
    expect(estimate.status).toBe('draft')
    expect(estimate.version).toBe(1)
    expect(estimate.lines).toHaveLength(2)
    expect(estimate.lines[0].lineTotal).toBe(4500)
    expect(estimate.lines[1].lineTotal).toBe(8 * 165)

    const refetched = h.proposals.getEstimate(estimate.id)
    expect(refetched).toEqual(estimate)
  })

  it('emits estimate.created and writes an audit row', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('estimate.created', (e) => {
      captured.push(e)
    })
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'agent', sessionId: 'sess-1' } },
    )
    await new Promise((r) => setImmediate(r))
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      type: 'estimate.created',
      projectId,
      estimateId: e.id,
    })
    const entries = h.audit.listByEntity('estimate', e.id)
    expect(entries).toHaveLength(1)
    expect(entries[0].action).toBe('estimate.created')
    expect(entries[0].actor).toEqual({ type: 'agent', sessionId: 'sess-1' })
  })

  it('throws when the project does not exist (FK)', () => {
    expect(() =>
      h.proposals.createEstimate(
        { projectId: 'no-such-project', lines: [] },
        { actor: { type: 'user' } },
      ),
    ).toThrow()
  })

  it('setEstimateStatus emits estimate.accepted on draft → accepted (and sets decided_at)', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('estimate.accepted', (e) => {
      captured.push(e)
    })
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    h.proposals.setEstimateStatus(e.id, 'accepted', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))

    const refetched = h.proposals.getEstimate(e.id)
    expect(refetched?.status).toBe('accepted')
    expect(refetched?.decidedAt).toBeGreaterThan(0)
    expect(captured).toHaveLength(1)
  })

  it('setEstimateStatus emits estimate.rejected on rejected', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('estimate.rejected', (e) => {
      captured.push(e)
    })
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    h.proposals.setEstimateStatus(e.id, 'rejected', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))
    expect(captured).toHaveLength(1)
  })

  it('setEstimateStatus emits estimate.updated on draft → ready', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('estimate.updated', (e) => {
      captured.push(e)
    })
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    h.proposals.setEstimateStatus(e.id, 'ready', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))
    expect(captured).toHaveLength(1)
  })

  it('listEstimatesForProject returns rows in created_at desc, including lines', () => {
    const projectId = makeProject()
    const a = h.proposals.createEstimate(
      { projectId, lines: [{ kind: 'fixed', description: 'a', qty: 1, unitPrice: 10 }] },
      { actor: { type: 'user' } },
    )
    const b = h.proposals.createEstimate(
      { projectId, lines: [{ kind: 'fixed', description: 'b', qty: 2, unitPrice: 20 }] },
      { actor: { type: 'user' } },
    )
    const list = h.proposals.listEstimatesForProject(projectId)
    expect(list.map((x) => x.id)).toEqual([b.id, a.id])
    expect(list[0].lines).toHaveLength(1)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { createAuditLog, type AuditLog } from '@/modules/audit-log.js'

interface Harness {
  db: Db
  audit: AuditLog
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const audit = createAuditLog(db)
  return { db, audit }
}

function disposeHarness(h: Harness): void {
  h.db.close()
}

describe('AuditLog — record and read-back', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('persists a record and returns it through listByEntity', () => {
    const entry = h.audit.record({
      module: 'projects',
      action: 'project.created',
      entityType: 'project',
      entityId: 'proj-24001',
      actor: { type: 'agent', sessionId: 'sess-abc' },
      payload: { number: '24001', name: 'Riverside Reno' },
    })

    expect(entry.id).toBeGreaterThan(0)
    expect(entry.ts).toBeGreaterThan(0)
    expect(entry.module).toBe('projects')
    expect(entry.action).toBe('project.created')
    expect(entry.entityType).toBe('project')
    expect(entry.entityId).toBe('proj-24001')
    expect(entry.actor).toEqual({ type: 'agent', sessionId: 'sess-abc' })
    expect(entry.payload).toEqual({ number: '24001', name: 'Riverside Reno' })

    const results = h.audit.listByEntity('project', 'proj-24001')
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(entry)
  })

  it('lists multiple entries for one entity in chronological order', () => {
    const created = h.audit.record({
      module: 'projects',
      action: 'project.created',
      entityType: 'project',
      entityId: 'proj-1',
      actor: { type: 'user' },
    })
    const renamed = h.audit.record({
      module: 'projects',
      action: 'project.renamed',
      entityType: 'project',
      entityId: 'proj-1',
      actor: { type: 'agent', sessionId: 'sess-1' },
      payload: { from: 'Old', to: 'New' },
    })
    const archived = h.audit.record({
      module: 'projects',
      action: 'project.archived',
      entityType: 'project',
      entityId: 'proj-1',
      actor: { type: 'user' },
    })
    h.audit.record({
      module: 'projects',
      action: 'project.created',
      entityType: 'project',
      entityId: 'proj-2',
      actor: { type: 'user' },
    })

    const results = h.audit.listByEntity('project', 'proj-1')
    expect(results.map((r) => r.action)).toEqual([
      'project.created',
      'project.renamed',
      'project.archived',
    ])
    expect(results.map((r) => r.id)).toEqual([created.id, renamed.id, archived.id])
  })
})

describe('AuditLog.listByModule', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('returns entries for the given module newest-first', () => {
    const a = h.audit.record({
      module: 'projects',
      action: 'project.created',
      entityType: 'project',
      entityId: 'p1',
      actor: { type: 'user' },
    })
    const b = h.audit.record({
      module: 'projects',
      action: 'project.archived',
      entityType: 'project',
      entityId: 'p1',
      actor: { type: 'user' },
    })
    h.audit.record({
      module: 'email',
      action: 'email.filed',
      entityType: 'email',
      entityId: 'e1',
      actor: { type: 'user' },
    })

    const results = h.audit.listByModule('projects')
    expect(results.map((r) => r.id)).toEqual([b.id, a.id])
    expect(results.every((r) => r.module === 'projects')).toBe(true)
  })

  it('honors the limit option', () => {
    for (let i = 0; i < 5; i++) {
      h.audit.record({
        module: 'projects',
        action: 'project.created',
        entityType: 'project',
        entityId: `p${i}`,
        actor: { type: 'user' },
      })
    }

    const results = h.audit.listByModule('projects', { limit: 2 })
    expect(results).toHaveLength(2)
  })
})

describe('AuditLog — actor variants', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it.each([
    { type: 'agent', sessionId: 'sess-1' } as const,
    { type: 'user' } as const,
    { type: 'scheduler', id: 'invoicing.pollQbo' } as const,
    { type: 'hook', id: 'wiki.notify-team' } as const,
    { type: 'module', module: 'invoicing' } as const,
  ])('persists actor variant %j', (actor) => {
    h.audit.record({
      module: 'projects',
      action: 'project.touched',
      entityType: 'project',
      entityId: 'p1',
      actor,
    })

    const [entry] = h.audit.listByEntity('project', 'p1')
    expect(entry.actor).toEqual(actor)
  })
})

describe('AuditLog — payload handling', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('defaults missing payload to an empty object', () => {
    h.audit.record({
      module: 'projects',
      action: 'project.touched',
      entityType: 'project',
      entityId: 'p1',
      actor: { type: 'user' },
    })

    const [entry] = h.audit.listByEntity('project', 'p1')
    expect(entry.payload).toEqual({})
  })

  it('preserves nested structures verbatim', () => {
    const payload = {
      before: { name: 'Old', tasks: [1, 2, 3] },
      after: { name: 'New', tasks: [1, 2, 3, 4] },
      meta: { reason: 'rename' },
    }
    h.audit.record({
      module: 'projects',
      action: 'project.updated',
      entityType: 'project',
      entityId: 'p1',
      actor: { type: 'user' },
      payload,
    })

    const [entry] = h.audit.listByEntity('project', 'p1')
    expect(entry.payload).toEqual(payload)
  })

  it('preserves explicit null payload', () => {
    h.audit.record({
      module: 'projects',
      action: 'project.touched',
      entityType: 'project',
      entityId: 'p1',
      actor: { type: 'user' },
      payload: null,
    })

    const [entry] = h.audit.listByEntity('project', 'p1')
    expect(entry.payload).toBeNull()
  })
})

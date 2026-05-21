import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { ExpertSpendTracker } from '@/skills/expert-spend.js'

interface Harness {
  db: Db
  store: ConversationStore
  sessionId: string
  otherSessionId: string
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const store = createConversationStore(db)
  const s1 = store.createSession({ agentProfile: 'researcher' })
  const s2 = store.createSession({ agentProfile: 'researcher' })
  return { db, store, sessionId: s1.id, otherSessionId: s2.id }
}

describe('ConversationStore expert_spend ledger', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('appends a row and lists it back for the session', () => {
    h.store.appendExpertSpend({
      sessionId: h.sessionId,
      model: 'openrouter-claude-sonnet',
      costUsd: 0.000144,
      inputTokens: 20,
      outputTokens: 5,
    })
    const rows = h.store.listExpertSpendForSession(h.sessionId)
    expect(rows).toEqual([
      {
        model: 'openrouter-claude-sonnet',
        costUsd: 0.000144,
        inputTokens: 20,
        outputTokens: 5,
      },
    ])
  })

  it('sumExpertSpend({sessionId}) scopes to one session', () => {
    h.store.appendExpertSpend({
      sessionId: h.sessionId, model: 'm', costUsd: 0.10, inputTokens: 0, outputTokens: 0,
    })
    h.store.appendExpertSpend({
      sessionId: h.sessionId, model: 'm', costUsd: 0.20, inputTokens: 0, outputTokens: 0,
    })
    h.store.appendExpertSpend({
      sessionId: h.otherSessionId, model: 'm', costUsd: 99, inputTokens: 0, outputTokens: 0,
    })
    const sum = h.store.sumExpertSpend({ sessionId: h.sessionId })
    expect(sum.totalUsd).toBeCloseTo(0.30, 4)
    expect(sum.totalCalls).toBe(2)
    expect(sum.byModel).toHaveLength(1)
    expect(sum.byModel[0]!.model).toBe('m')
    expect(sum.byModel[0]!.calls).toBe(2)
    expect(sum.byModel[0]!.costUsd).toBeCloseTo(0.30, 4)
  })

  it('sumExpertSpend() with no filter aggregates across all sessions and groups by model', () => {
    h.store.appendExpertSpend({
      sessionId: h.sessionId, model: 'sonnet', costUsd: 0.10, inputTokens: 0, outputTokens: 0,
    })
    h.store.appendExpertSpend({
      sessionId: h.otherSessionId, model: 'opus', costUsd: 0.25, inputTokens: 0, outputTokens: 0,
    })
    h.store.appendExpertSpend({
      sessionId: h.otherSessionId, model: 'sonnet', costUsd: 0.05, inputTokens: 0, outputTokens: 0,
    })
    const sum = h.store.sumExpertSpend()
    expect(sum.totalUsd).toBeCloseTo(0.40, 4)
    expect(sum.totalCalls).toBe(3)
    // Ordered by costUsd desc.
    expect(sum.byModel.map((b) => b.model)).toEqual(['opus', 'sonnet'])
    const sonnet = sum.byModel.find((b) => b.model === 'sonnet')!
    expect(sonnet.calls).toBe(2)
    expect(sonnet.costUsd).toBeCloseTo(0.15, 4)
  })

  it('returns zero totals when the ledger is empty', () => {
    const sum = h.store.sumExpertSpend()
    expect(sum).toEqual({ totalUsd: 0, totalCalls: 0, byModel: [] })
  })

  it('FK cascades — deleting a session removes its spend rows', () => {
    h.store.appendExpertSpend({
      sessionId: h.sessionId, model: 'm', costUsd: 1, inputTokens: 0, outputTokens: 0,
    })
    h.db.prepare('DELETE FROM sessions WHERE id = ?').run(h.sessionId)
    expect(h.store.listExpertSpendForSession(h.sessionId)).toEqual([])
  })
})

describe('ExpertSpendTracker persistence', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('persists each add() to the ledger so a new tracker for the same session rehydrates', () => {
    const t1 = new ExpertSpendTracker({ sessionId: h.sessionId, store: h.store })
    t1.add('sonnet', 0.10, { inputTokens: 30, outputTokens: 10 })
    t1.add('sonnet', 0.05)
    t1.add('opus', 0.20)
    expect(t1.total).toBeCloseTo(0.35, 4)

    // Simulate a server restart: build a brand-new tracker against the same
    // session id and store. The constructor reads the ledger.
    const t2 = new ExpertSpendTracker({ sessionId: h.sessionId, store: h.store })
    expect(t2.total).toBeCloseTo(0.35, 4)
    const sonnet = t2.byModel().find((b) => b.model === 'sonnet')
    expect(sonnet?.calls).toBe(2)
    expect(sonnet?.usd).toBeCloseTo(0.15, 4)
  })

  it('does not leak spend from other sessions on rehydrate', () => {
    new ExpertSpendTracker({ sessionId: h.otherSessionId, store: h.store }).add('m', 99)
    const t = new ExpertSpendTracker({ sessionId: h.sessionId, store: h.store })
    expect(t.total).toBe(0)
  })

  it('opts out of persistence when store is null', () => {
    const t = new ExpertSpendTracker({ sessionId: h.sessionId, store: null })
    t.add('sonnet', 0.10)
    // Ledger should be untouched.
    expect(h.store.sumExpertSpend().totalUsd).toBe(0)
    // But in-memory cache still tracks.
    expect(t.total).toBeCloseTo(0.10, 4)
  })

  it('still ignores negative / non-finite costs (no ledger row appended)', () => {
    const t = new ExpertSpendTracker({ sessionId: h.sessionId, store: h.store })
    t.add('m', -1)
    t.add('m', Number.NaN)
    t.add('m', Number.POSITIVE_INFINITY)
    expect(t.total).toBe(0)
    expect(h.store.sumExpertSpend().totalCalls).toBe(0)
  })
})

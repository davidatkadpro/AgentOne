import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'

interface Harness {
  db: Db
  store: ConversationStore
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const store = createConversationStore(db)
  return { db, store }
}

function disposeHarness(h: Harness): void {
  h.db.close()
}

describe('ConversationStore migration', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('installs turns_fts and reaches the current schema version on a fresh db', () => {
    const version = h.db.pragma('user_version', { simple: true })
    expect(version).toBe(8)
    const fts = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='turns_fts'")
      .get()
    expect(fts).toBeTruthy()
    const triggers = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'turns_fts_%'")
      .all() as Array<{ name: string }>
    expect(triggers.map((t) => t.name).sort()).toEqual([
      'turns_fts_ad',
      'turns_fts_ai',
      'turns_fts_au',
    ])
  })

  it('creates the compression_state table on a fresh db', () => {
    const row = h.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='compression_state'",
      )
      .get()
    expect(row).toBeTruthy()
  })
})

describe('ConversationStore.compression_state', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('round-trips save → get → clear', () => {
    const session = h.store.createSession({ agentProfile: 'p', title: 't' })
    expect(h.store.getCompressionState(session.id)).toBeUndefined()

    h.store.saveCompressionState({
      sessionId: session.id,
      summaryText: 'a digest',
      throughTurnCount: 12,
    })
    const got = h.store.getCompressionState(session.id)
    expect(got?.summaryText).toBe('a digest')
    expect(got?.throughTurnCount).toBe(12)
    expect(got?.updatedAt).toBeGreaterThan(0)

    h.store.clearCompressionState(session.id)
    expect(h.store.getCompressionState(session.id)).toBeUndefined()
  })

  it('upsert replaces an existing row', () => {
    const session = h.store.createSession({ agentProfile: 'p', title: 't' })
    h.store.saveCompressionState({
      sessionId: session.id,
      summaryText: 'first',
      throughTurnCount: 4,
    })
    h.store.saveCompressionState({
      sessionId: session.id,
      summaryText: 'second',
      throughTurnCount: 7,
    })
    const got = h.store.getCompressionState(session.id)
    expect(got?.summaryText).toBe('second')
    expect(got?.throughTurnCount).toBe(7)
  })

  it('cascades on session delete', () => {
    const session = h.store.createSession({ agentProfile: 'p', title: 't' })
    h.store.saveCompressionState({
      sessionId: session.id,
      summaryText: 's',
      throughTurnCount: 1,
    })
    // No store method to delete a session; do it directly via the FK
    // cascade — sessions.id REFERENCES drives the deletion below.
    h.db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id)
    expect(h.store.getCompressionState(session.id)).toBeUndefined()
  })
})

describe('ConversationStore.searchTurns', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  function seed(): { sessionA: string; sessionB: string } {
    const a = h.store.createSession({ agentProfile: 'p', title: 'Coffee chat' })
    const b = h.store.createSession({ agentProfile: 'p', title: 'Cars chat' })
    h.store.appendTurn({ sessionId: a.id, role: 'user', content: 'I love a flat white in the morning.' })
    h.store.appendTurn({
      sessionId: a.id,
      role: 'assistant',
      content: 'Noted — flat white is your default coffee order.',
    })
    h.store.appendTurn({ sessionId: b.id, role: 'user', content: 'Show me electric cars under $40k.' })
    h.store.appendTurn({
      sessionId: b.id,
      role: 'assistant',
      content: 'Here are several electric cars in that range.',
    })
    return { sessionA: a.id, sessionB: b.id }
  }

  it('finds matches across sessions and returns session/role metadata', () => {
    const { sessionA } = seed()
    const hits = h.store.searchTurns({ query: 'coffee' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.sessionId === sessionA)).toBe(true)
    expect(hits[0].sessionTitle).toBe('Coffee chat')
    expect(hits[0].snippet).toContain('coffee')
  })

  it('excludes the named session via excludeSessionId', () => {
    const { sessionA, sessionB } = seed()
    const hits = h.store.searchTurns({
      query: 'electric OR coffee',
      excludeSessionId: sessionB,
    })
    expect(hits.every((h) => h.sessionId === sessionA)).toBe(true)
  })

  it('restricts results to a specific session id', () => {
    const { sessionB } = seed()
    const hits = h.store.searchTurns({ query: 'electric', sessionId: sessionB })
    expect(hits.length).toBe(2)
    expect(hits.every((h) => h.sessionId === sessionB)).toBe(true)
  })

  it('filters by role', () => {
    seed()
    const userHits = h.store.searchTurns({ query: 'electric OR coffee', roles: ['user'] })
    expect(userHits.every((h) => h.role === 'user')).toBe(true)
    const assistantHits = h.store.searchTurns({
      query: 'electric OR coffee',
      roles: ['assistant'],
    })
    expect(assistantHits.every((h) => h.role === 'assistant')).toBe(true)
  })

  it('keeps index in sync via triggers on delete', () => {
    const s = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: s.id, role: 'user', content: 'kangaroos hop' })
    expect(h.store.searchTurns({ query: 'kangaroos' }).length).toBe(1)
    h.db.prepare('DELETE FROM turns WHERE session_id = ?').run(s.id)
    expect(h.store.searchTurns({ query: 'kangaroos' }).length).toBe(0)
  })

  it('backfills existing turns when migrating an empty fts table', () => {
    // Simulate a pre-v4 database by dropping the fts table + triggers, inserting
    // a turn, then re-running the migration via createConversationStore.
    h.db.exec(`
      DROP TRIGGER IF EXISTS turns_fts_ai;
      DROP TRIGGER IF EXISTS turns_fts_ad;
      DROP TRIGGER IF EXISTS turns_fts_au;
      DROP TABLE IF EXISTS turns_fts;
    `)
    h.db.pragma('user_version = 3')
    const s = h.store.createSession({ agentProfile: 'p' })
    h.db
      .prepare(
        'INSERT INTO turns (id, session_id, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('legacy-turn-1', s.id, 'user', 'platypus discovery', 0, Date.now())
    // Re-run migration by constructing a new store on same db.
    const store2 = createConversationStore(h.db)
    const hits = store2.searchTurns({ query: 'platypus' })
    expect(hits.length).toBe(1)
    expect(hits[0].turnId).toBe('legacy-turn-1')
  })
})

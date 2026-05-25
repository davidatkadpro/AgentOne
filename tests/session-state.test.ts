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

describe('Session state and spawned_by — defaults', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it("a new session defaults to state='active' and spawnedBy=null", () => {
    const session = h.store.createSession({ agentProfile: 'general' })

    expect(session.state).toBe('active')
    expect(session.spawnedBy).toBeNull()
  })

  it("getSession returns state='active' and spawnedBy=null for human-created sessions", () => {
    const created = h.store.createSession({ agentProfile: 'general' })
    const fetched = h.store.getSession(created.id)

    expect(fetched?.state).toBe('active')
    expect(fetched?.spawnedBy).toBeNull()
  })

  it('persists an explicit spawnedBy value on the session row', () => {
    const session = h.store.createSession({
      agentProfile: 'email-actor',
      spawnedBy: 'modules/email',
    })

    expect(session.spawnedBy).toBe('modules/email')

    const fetched = h.store.getSession(session.id)
    expect(fetched?.spawnedBy).toBe('modules/email')
  })
})

describe('Session state — transitions', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('setSessionState flips active → awaiting_input → active', () => {
    const created = h.store.createSession({ agentProfile: 'general' })

    h.store.setSessionState(created.id, 'awaiting_input')
    expect(h.store.getSession(created.id)?.state).toBe('awaiting_input')

    h.store.setSessionState(created.id, 'active')
    expect(h.store.getSession(created.id)?.state).toBe('active')
  })

  it('setSessionState can archive a session', () => {
    const created = h.store.createSession({ agentProfile: 'general' })
    h.store.setSessionState(created.id, 'archived')
    expect(h.store.getSession(created.id)?.state).toBe('archived')
  })

  it('rejects an unknown state value at the DB boundary', () => {
    const created = h.store.createSession({ agentProfile: 'general' })
    const setBadState = h.store.setSessionState as (id: string, state: string) => void
    expect(() => setBadState(created.id, 'pizza')).toThrow()
    expect(h.store.getSession(created.id)?.state).toBe('active')
  })
})

describe('Session state — migration from legacy schema', () => {
  it('migrates a pre-v7 sessions table and backfills existing rows', () => {
    const db = createDatabase({ path: ':memory:', skipMkdir: true })

    // Bootstrap the full v6 schema (turns, tool_calls, event_log, FTS, vec0,
    // embedding_state, expert_spend_v1) by booting the store once, then
    // revert `sessions` to its pre-v7 shape and rewind user_version. This
    // simulates a user who installed v1, then upgrades to v7.
    createConversationStore(db)
    db.exec(`
      DROP TABLE sessions;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        agent_profile TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    db.prepare(
      'INSERT INTO sessions (id, title, agent_profile, created_at) VALUES (?, ?, ?, ?)',
    ).run('legacy-sess-1', 'Pre-v7 chat', 'general', 1700000000000)
    db.pragma('user_version = 6')

    // Boot the store again — v7 migration should run and backfill cleanly.
    const store = createConversationStore(db)

    const fetched = store.getSession('legacy-sess-1')
    expect(fetched).toBeDefined()
    expect(fetched?.title).toBe('Pre-v7 chat')
    expect(fetched?.agentProfile).toBe('general')
    expect(fetched?.state).toBe('active')
    expect(fetched?.spawnedBy).toBeNull()

    expect(db.pragma('user_version', { simple: true })).toBe(8)

    db.close()
  })
})

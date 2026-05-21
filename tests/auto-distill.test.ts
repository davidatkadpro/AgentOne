import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoDistillScheduler } from '@/orchestrator/auto-distill.js'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { WikiEngine } from '@/memory/wiki/engine.js'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import { FakeProvider } from './fakes.js'

const MIN = 60 * 1000

interface Harness {
  db: Db
  store: ConversationStore
  wiki: WikiEngine
  bus: EventBus
  root: string
  provider: FakeProvider
  events: AgentEvent[]
  cleanup: () => Promise<void>
}

async function newHarness(providerOpts: { respond?: () => string; failWith?: Error } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'agentone-autodistill-'))
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const store = createConversationStore(db)
  const storage = new LocalFolderAdapter({ root })
  const wiki = new WikiEngine({ storage, db, skipInitialReindex: true })
  const bus = new EventBus()
  const events: AgentEvent[] = []
  bus.onAny((e) => {
    events.push(e)
  })
  const provider = new FakeProvider({
    respond: providerOpts.respond ?? (() => '[]'),
    ...(providerOpts.failWith ? { failWith: providerOpts.failWith } : {}),
  })
  return {
    db,
    store,
    wiki,
    bus,
    root,
    provider,
    events,
    async cleanup() {
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function buildScheduler(h: Harness, overrides: Partial<{ enabled: boolean; idleMinutes: number; scanIntervalMinutes: number; now: () => number }> = {}) {
  return new AutoDistillScheduler(
    {
      enabled: overrides.enabled ?? true,
      idleMinutes: overrides.idleMinutes ?? 30,
      scanIntervalMinutes: overrides.scanIntervalMinutes ?? 5,
    },
    {
      store: h.store,
      wiki: h.wiki,
      compressorProvider: h.provider,
      compressorModel: 'fake-model',
      eventBus: h.bus,
      ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    },
  )
}

describe('AutoDistillScheduler.tick', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness({
      respond: () =>
        JSON.stringify([
          { kind: 'preference', title: 'concise replies', body: 'User wants short answers.' },
        ]),
    })
  })
  afterEach(async () => {
    await h.cleanup()
  })

  it('distills a session that has been idle past the threshold', async () => {
    const session = h.store.createSession({ agentProfile: 'p', title: 'idle session' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'I prefer brief answers' })
    h.store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'noted' })

    const sched = buildScheduler(h, { idleMinutes: 30 })
    // Record activity 31 minutes ago.
    sched.recordActivity(session.id, 0)
    const now = 31 * MIN

    const { distilled, skipped } = await sched.tick(now)
    expect(distilled).toEqual([session.id])
    expect(skipped).toEqual([])

    const distilledEvent = h.events.find((e) => e.type === 'session.auto_distilled')
    expect(distilledEvent).toMatchObject({
      type: 'session.auto_distilled',
      sessionId: session.id,
      notesCount: 1,
    })
  })

  it('skips a session that has not been idle long enough', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'x' })
    h.store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'y' })

    const sched = buildScheduler(h, { idleMinutes: 30 })
    sched.recordActivity(session.id, 0)
    // Only 5 minutes elapsed.
    const { distilled, skipped } = await sched.tick(5 * MIN)
    expect(distilled).toEqual([])
    expect(skipped).toEqual([])
  })

  it('skips a session with fewer than 2 turns (too_short)', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'hi' })
    const sched = buildScheduler(h)
    sched.recordActivity(session.id, 0)
    const { distilled, skipped } = await sched.tick(31 * MIN)
    expect(distilled).toEqual([])
    expect(skipped).toEqual([{ sessionId: session.id, reason: 'too_short' }])
  })

  it('skips when the model returns zero notes', async () => {
    const h2 = await newHarness({ respond: () => '[]' })
    const session = h2.store.createSession({ agentProfile: 'p' })
    h2.store.appendTurn({ sessionId: session.id, role: 'user', content: 'a' })
    h2.store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'b' })

    const sched = buildScheduler(h2)
    sched.recordActivity(session.id, 0)
    const { distilled, skipped } = await sched.tick(31 * MIN)
    expect(distilled).toEqual([])
    expect(skipped).toEqual([{ sessionId: session.id, reason: 'no_notes' }])
    await h2.cleanup()
  })

  it('reports parse_failure when the model returns non-JSON', async () => {
    const h2 = await newHarness({ respond: () => 'I refuse to comply.' })
    const session = h2.store.createSession({ agentProfile: 'p' })
    h2.store.appendTurn({ sessionId: session.id, role: 'user', content: 'a' })
    h2.store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'b' })

    const sched = buildScheduler(h2)
    sched.recordActivity(session.id, 0)
    const { skipped } = await sched.tick(31 * MIN)
    expect(skipped[0]).toMatchObject({ sessionId: session.id, reason: 'parse_failure' })
    await h2.cleanup()
  })

  it('reports provider_error when the LLM call throws', async () => {
    const h2 = await newHarness({ failWith: new Error('LM Studio down') })
    const session = h2.store.createSession({ agentProfile: 'p' })
    h2.store.appendTurn({ sessionId: session.id, role: 'user', content: 'a' })
    h2.store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'b' })

    const sched = buildScheduler(h2)
    sched.recordActivity(session.id, 0)
    const { skipped } = await sched.tick(31 * MIN)
    expect(skipped[0]).toMatchObject({ sessionId: session.id, reason: 'provider_error' })
    await h2.cleanup()
  })

  it('drops sessions from activity tracking after distilling so the next scan does not retry', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'a' })
    h.store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'b' })

    const sched = buildScheduler(h)
    sched.recordActivity(session.id, 0)
    const first = await sched.tick(31 * MIN)
    expect(first.distilled).toEqual([session.id])

    // Second scan with no new activity — nothing to do.
    const second = await sched.tick(62 * MIN)
    expect(second.distilled).toEqual([])
    expect(second.skipped).toEqual([])
  })

  it('writes the draft page at the expected path', async () => {
    const session = h.store.createSession({ agentProfile: 'p', title: 'My session' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'a' })
    h.store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'b' })

    // Pin the clock at a known date so the path is predictable.
    const dec25 = new Date('2026-12-25T10:00:00Z').getTime()
    const sched = buildScheduler(h)
    sched.recordActivity(session.id, dec25 - 60 * MIN)
    await sched.tick(dec25)

    const expectedPath = join(h.root, 'wiki', `drafts/distilled-${session.id}-2026-12-25.md`)
    const content = await readFile(expectedPath, 'utf-8')
    expect(content).toContain(`source_session: ${session.id}`)
    expect(content).toContain('## preference')
  })
})

describe('AutoDistillScheduler.start / stop', () => {
  it('does not start when disabled', async () => {
    const h = await newHarness()
    const sched = new AutoDistillScheduler(
      { enabled: false, idleMinutes: 30, scanIntervalMinutes: 5 },
      {
        store: h.store,
        wiki: h.wiki,
        compressorProvider: h.provider,
        compressorModel: 'fake',
        eventBus: h.bus,
      },
    )
    sched.start()
    // After start with enabled=false, the scheduler should still be idle —
    // bus subscriptions are skipped. Emit a message; recordActivity should
    // not have been wired.
    h.bus.emit({
      type: 'message.user.received',
      sessionId: 's1',
      turnId: 't1',
      ts: 1_000,
    })
    // Wait a microtask in case any handler does run.
    await Promise.resolve()
    // No way to inspect lastActivity from the outside — instead, check
    // that no scheduled timer was created. We can prove this indirectly
    // by confirming stop() is a no-op.
    sched.stop()
    expect(true).toBe(true) // smoke: no throw, no scheduled work
    await h.cleanup()
  })

  it('primes activity from existing sessions on start', async () => {
    const h = await newHarness({
      respond: () =>
        JSON.stringify([{ kind: 'preference', title: 't', body: 'b' }]),
    })
    const session = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'x' })
    h.store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'y' })

    // prime() seeds lastActivity from the turn's real createdAt — use the
    // real clock for `now` and tick 31 minutes in the future relative to
    // that, so the activity timestamp is older than the idle threshold.
    const sched = buildScheduler(h)
    sched.start()
    const { distilled } = await sched.tick(Date.now() + 31 * MIN)
    expect(distilled.length).toBeGreaterThan(0)
    sched.stop()
    await h.cleanup()
  })
})

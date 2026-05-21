import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AutoTitler, cleanTitle } from '@/orchestrator/auto-titler.js'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { EventBus, type AgentEvent, type EventByType } from '@/core/events.js'
import { FakeProvider } from './fakes.js'

describe('cleanTitle', () => {
  it('strips wrapping quotes', () => {
    expect(cleanTitle('"My Title"', 64)).toBe('My Title')
    expect(cleanTitle("'My Title'", 64)).toBe('My Title')
  })

  it('strips common prefixes', () => {
    expect(cleanTitle('Title: Working on parser', 64)).toBe('Working on parser')
    expect(cleanTitle('Re: Foo', 64)).toBe('Foo')
    expect(cleanTitle('Chat: Bar', 64)).toBe('Bar')
  })

  it('takes only the first line', () => {
    expect(cleanTitle('Line one\nLine two', 64)).toBe('Line one')
  })

  it('strips trailing punctuation', () => {
    expect(cleanTitle('Working on Parser.', 64)).toBe('Working on Parser')
    expect(cleanTitle('Question?', 64)).toBe('Question')
  })

  it('clamps to maxChars', () => {
    expect(cleanTitle('abcdefghij', 5)).toBe('abcde')
  })

  it('returns empty for empty input', () => {
    expect(cleanTitle('', 64)).toBe('')
    expect(cleanTitle('   ', 64)).toBe('')
  })
})

describe('AutoTitler', () => {
  let db: Db
  let store: ConversationStore
  let bus: EventBus
  let events: AgentEvent[]

  beforeEach(() => {
    db = createDatabase({ path: ':memory:', skipMkdir: true })
    store = createConversationStore(db)
    bus = new EventBus()
    events = []
    bus.onAny((e) => {
      events.push(e)
    })
  })
  afterEach(() => {
    db.close()
  })

  function buildTitler(opts: { respond?: string; failWith?: Error } = {}) {
    const provider = new FakeProvider({
      respond: () => opts.respond ?? 'Quick Test Title',
      ...(opts.failWith ? { failWith: opts.failWith } : {}),
    })
    const titler = new AutoTitler(
      { triggerAfterAssistantTurns: 2 },
      { store, titlerProvider: provider, titlerModel: 'fake-titler', eventBus: bus },
    )
    return { titler, provider }
  }

  function makeCompletionEvent(sessionId: string): EventByType<'message.assistant.completed'> {
    return {
      type: 'message.assistant.completed',
      sessionId,
      turnId: 'turn-id',
      inputTokens: 0,
      outputTokens: 0,
      ts: Date.now(),
    }
  }

  it('titles a session after the trigger threshold and sets it in the store', async () => {
    const session = store.createSession({ agentProfile: 'p' })
    store.appendTurn({ sessionId: session.id, role: 'user', content: 'hi' })
    store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'hello' })
    store.appendTurn({ sessionId: session.id, role: 'user', content: 'next' })
    store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'sure' })

    const { titler } = buildTitler({ respond: '"Working on Parser"' })
    await titler.maybeTitle(makeCompletionEvent(session.id))

    const updated = store.getSession(session.id)
    expect(updated?.title).toBe('Working on Parser')
    const titledEvent = events.find((e) => e.type === 'session.titled')
    expect(titledEvent).toMatchObject({ sessionId: session.id, title: 'Working on Parser' })
  })

  it('does not title sessions that already have a title', async () => {
    const session = store.createSession({ agentProfile: 'p', title: 'Manual Title' })
    store.appendTurn({ sessionId: session.id, role: 'user', content: 'hi' })
    store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'hello' })
    store.appendTurn({ sessionId: session.id, role: 'user', content: 'next' })
    store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'sure' })

    const { titler, provider } = buildTitler()
    await titler.maybeTitle(makeCompletionEvent(session.id))

    expect(store.getSession(session.id)?.title).toBe('Manual Title')
    expect(provider.calls.length).toBe(0)
  })

  it('does not title before the trigger threshold', async () => {
    const session = store.createSession({ agentProfile: 'p' })
    store.appendTurn({ sessionId: session.id, role: 'user', content: 'hi' })
    store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'hello' })
    // Only 1 assistant turn; trigger is 2.
    const { titler, provider } = buildTitler()
    await titler.maybeTitle(makeCompletionEvent(session.id))
    expect(store.getSession(session.id)?.title).toBeNull()
    expect(provider.calls.length).toBe(0)
  })

  it('swallows titler provider failures silently', async () => {
    const session = store.createSession({ agentProfile: 'p' })
    for (let i = 0; i < 2; i++) {
      store.appendTurn({ sessionId: session.id, role: 'user', content: 'q' })
      store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'a' })
    }
    const { titler } = buildTitler({ failWith: new Error('LM down') })
    await titler.maybeTitle(makeCompletionEvent(session.id))
    expect(store.getSession(session.id)?.title).toBeNull()
    expect(events.find((e) => e.type === 'session.titled')).toBeUndefined()
  })

  it('subscribes to bus events on start()', async () => {
    const session = store.createSession({ agentProfile: 'p' })
    for (let i = 0; i < 2; i++) {
      store.appendTurn({ sessionId: session.id, role: 'user', content: 'q' })
      store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'a' })
    }
    const { titler } = buildTitler({ respond: 'Auto Title' })
    titler.start()
    await bus.emit(makeCompletionEvent(session.id))
    // fire-and-forget — wait a tick
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(store.getSession(session.id)?.title).toBe('Auto Title')
    titler.stop()
  })
})

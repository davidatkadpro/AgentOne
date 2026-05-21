import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LMStudioProvider } from '@/providers/lmstudio.js'
import { Orchestrator } from '@/orchestrator/turn.js'
import { ContextManager } from '@/context/context-manager.js'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import type { ChatChunk, ChatRequest, ModelProfile } from '@/core/types.js'
import type { Provider } from '@/providers/base.js'
import type { SkillIndex } from '@/skills/loader.js'
import type { ResolvedAgentProfile } from '@/profiles/agent-profile.js'
import { fakeServices } from './fakes.js'

// ---------- LMStudioProvider signal forwarding ----------

describe('LMStudioProvider with AbortSignal', () => {
  it('forwards signal to fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const provider = new LMStudioProvider({
      baseUrl: 'http://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const ac = new AbortController()
    await provider.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
    })
    const [, init] = fetchImpl.mock.calls[0]!
    expect(init.signal).toBe(ac.signal)
  })

  it('does not retry when fetch rejects with AbortError mid-call', async () => {
    // Signal stays unaborted on the JS side, but fetch rejects with an
    // AbortError-shaped error — simulates the case where fetch's internal
    // abort path fired (e.g. server reset the connection). The provider
    // should propagate immediately without retrying.
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    const fetchImpl = vi.fn().mockRejectedValue(abortErr)
    const provider = new LMStudioProvider({
      baseUrl: 'http://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const ac = new AbortController()
    await expect(
      provider.chat({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // One attempt only — no retry.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws AbortError immediately if signal already aborted before first attempt', async () => {
    const fetchImpl = vi.fn()
    const provider = new LMStudioProvider({
      baseUrl: 'http://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const ac = new AbortController()
    ac.abort()
    await expect(
      provider.chat({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ---------- Orchestrator cancellation ----------

/** Provider that yields one chunk and then awaits an externally-resolved
 *  promise so we can interleave a cancellation between iterations. */
class GatedProvider implements Provider {
  readonly id = 'gated'
  readonly capabilities = { streaming: true, tools: true }
  readonly calls: ChatRequest[] = []
  /** External hook: resolves to release the stream past its mid-chunk wait. */
  gate: Promise<void> = Promise.resolve()
  releaseGate: () => void = () => {}
  sawSignal: AbortSignal | null = null

  constructor(private readonly handler: (req: ChatRequest) => ChatChunk[]) {}

  resetGate(): void {
    this.gate = new Promise((r) => {
      this.releaseGate = r
    })
  }

  async chat(): Promise<never> {
    throw new Error('unused')
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.calls.push(req)
    this.sawSignal = req.signal ?? null
    const chunks = this.handler(req)
    // Yield all but the final chunk, then await the gate. This simulates a
    // slow provider stream that can be cancelled mid-flight.
    for (let i = 0; i < chunks.length - 1; i++) {
      // Honour cancellation if it lands during streaming.
      if (req.signal?.aborted) {
        const e = new Error('aborted')
        e.name = 'AbortError'
        throw e
      }
      yield chunks[i]!
    }
    await this.gate
    if (req.signal?.aborted) {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    yield chunks[chunks.length - 1]!
  }
}

const baseModelProfile: ModelProfile = {
  id: 'fake',
  provider: 'lmstudio',
  model: 'fake-model',
  role: 'general',
  contextWindow: 32_768,
  params: {},
}

const baseAgentProfile: ResolvedAgentProfile = {
  id: 'test',
  systemPromptFile: null,
  defaultModel: 'fake',
  compressorModel: null,
  defaultSkills: [],
  permissions: {
    skills: { allow: [], deny: [] },
    experts: { allow: [], budgetPerCallUsd: null, budgetPerSessionUsd: null },
  },
  passiveRecall: { enabled: false, wikiHits: 2, historyHits: 2, maxCharsPerHit: 240 },
  autoDistill: { enabled: false, idleMinutes: 30, scanIntervalMinutes: 5 },
  denyTools: [],
  sourceFile: '',
}

const emptySkillIndex: SkillIndex = {
  skills: new Map(),
  categories: new Map(),
  bySlashCommand: new Map(),
}

interface Harness {
  db: Db
  store: ConversationStore
  bus: EventBus
  events: AgentEvent[]
  provider: GatedProvider
  orchestrator: Orchestrator
  cleanup: () => void
}

function newHarness(handler: (req: ChatRequest) => ChatChunk[]): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const store = createConversationStore(db)
  const bus = new EventBus()
  const events: AgentEvent[] = []
  bus.onAny((e) => {
    events.push(e)
  })
  const provider = new GatedProvider(handler)
  const contextManager = new ContextManager({
    compressorProvider: {
      id: 'fake-comp',
      capabilities: { streaming: false, tools: false },
      async chat() {
        return { content: 'sum', inputTokens: 0, outputTokens: 0, finishReason: 'stop' }
      },
      async *stream() {
        throw new Error('unused')
      },
    },
    compressorModel: 'fake-comp',
    contextWindow: 32_768,
    eventBus: bus,
  })
  const orchestrator = new Orchestrator({
    store,
    contextManager,
    provider,
    conversationModel: baseModelProfile,
    eventBus: bus,
    skillIndex: emptySkillIndex,
    profile: baseAgentProfile,
    basePrompt: 'You are a test agent.',
    services: fakeServices({ conversationStore: store, eventBus: bus }),
  })
  return {
    db,
    store,
    bus,
    events,
    provider,
    orchestrator,
    cleanup: () => db.close(),
  }
}

/** Drain the async iterable. Returns the concatenated text. */
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += chunk
  return out
}

describe('Orchestrator.cancelSession', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness((_req) => [
      { delta: 'partial...', done: false },
      { delta: '', done: true, inputTokens: 5, outputTokens: 5, finishReason: 'stop' },
    ])
  })
  afterEach(() => {
    h.cleanup()
  })

  it('returns unknown_session when the session has never been touched', async () => {
    const out = await h.orchestrator.cancelSession('never-existed')
    expect(out).toBe('unknown_session')
  })

  it('returns no_active_turn after a completed turn', async () => {
    const session = h.store.createSession({ agentProfile: 'test' })
    h.provider.resetGate()
    h.provider.releaseGate() // let the turn finish immediately
    const handle = await h.orchestrator.handleUserMessage(session.id, 'hello')
    await drain(handle.stream)

    const out = await h.orchestrator.cancelSession(session.id)
    expect(out).toBe('no_active_turn')
  })

  it('cancels a mid-stream turn and emits turn.cancel_requested + turn.cancelled(hard)', async () => {
    const session = h.store.createSession({ agentProfile: 'test' })
    h.provider.resetGate()
    const handle = await h.orchestrator.handleUserMessage(session.id, 'long question')

    // Start draining in the background — it will await the gate.
    const drainPromise = drain(handle.stream)

    // Yield a microtask so the stream picks up the first delta.
    await new Promise((r) => setImmediate(r))

    const outcome = await h.orchestrator.cancelSession(session.id)
    expect(outcome).toBe('cancelled')

    // Release the gate so the provider's await unblocks — but it'll see
    // signal.aborted and throw AbortError, which the orchestrator catches.
    h.provider.releaseGate()
    await drainPromise

    expect(h.events.some((e) => e.type === 'turn.cancel_requested')).toBe(true)
    const cancelled = h.events.find((e) => e.type === 'turn.cancelled')
    expect(cancelled).toBeDefined()
    expect(cancelled).toMatchObject({ sessionId: session.id, kind: 'hard' })
  })

  it('threads the AbortSignal into ChatRequest', async () => {
    const session = h.store.createSession({ agentProfile: 'test' })
    h.provider.resetGate()
    h.provider.releaseGate()
    const handle = await h.orchestrator.handleUserMessage(session.id, 'q')
    await drain(handle.stream)

    expect(h.provider.sawSignal).not.toBeNull()
    expect(typeof h.provider.sawSignal!.aborted).toBe('boolean')
  })

  it('is idempotent — calling cancelSession twice on the same turn is fine', async () => {
    const session = h.store.createSession({ agentProfile: 'test' })
    h.provider.resetGate()
    const handle = await h.orchestrator.handleUserMessage(session.id, 'q')
    const drainPromise = drain(handle.stream)
    await new Promise((r) => setImmediate(r))

    const first = await h.orchestrator.cancelSession(session.id)
    const second = await h.orchestrator.cancelSession(session.id)
    expect(first).toBe('cancelled')
    // Second call returns no_active_turn because the controller is now aborted
    // (signal.aborted === true).
    expect(second).toBe('no_active_turn')

    h.provider.releaseGate()
    await drainPromise
  })
})


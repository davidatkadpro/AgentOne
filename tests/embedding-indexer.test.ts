import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, EMBEDDING_DIM, type ConversationStore } from '@/storage/sqlite.js'
import { EmbeddingIndexer } from '@/search/embedding-indexer.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import type { Provider } from '@/providers/base.js'

interface ProbeProvider extends Provider {
  embedCalls: string[][]
}

function makeProvider(opts: { failOn?: number } = {}): ProbeProvider {
  let invocations = 0
  const calls: string[][] = []
  const provider: ProbeProvider = {
    id: 'fake',
    capabilities: { streaming: false, tools: false },
    embedCalls: calls,
    async chat() {
      throw new Error('unused')
    },
    async *stream() {
      throw new Error('unused')
    },
    async embed(req) {
      invocations++
      calls.push(req.input)
      if (opts.failOn === invocations) {
        throw new Error('synthetic embedding failure')
      }
      return {
        model: req.model,
        embeddings: req.input.map((_, i) => {
          const v = new Array(EMBEDDING_DIM).fill(0)
          v[i % EMBEDDING_DIM] = 1
          return v
        }),
        tokens: 0,
      }
    },
  }
  return provider
}

interface Harness {
  db: Db
  store: ConversationStore
  bus: EventBus
  events: AgentEvent[]
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const store = createConversationStore(db)
  const bus = new EventBus()
  const events: AgentEvent[] = []
  bus.onAny((e) => {
    events.push(e)
  })
  return { db, store, bus, events }
}

describe('EmbeddingIndexer.drainOnce', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('embeds every pending user/assistant turn', async () => {
    const sess = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: sess.id, role: 'user', content: 'hello' })
    h.store.appendTurn({ sessionId: sess.id, role: 'assistant', content: 'world' })
    const provider = makeProvider()
    const indexer = new EmbeddingIndexer({
      store: h.store,
      provider,
      model: 'fake-embed',
      eventBus: h.bus,
      batchSize: 16,
      backfillBatch: 64,
    })
    const count = await indexer.drainOnce()
    expect(count).toBe(2)
    expect(provider.embedCalls.flat().sort()).toEqual(['hello', 'world'])
    expect(
      h.store.listTurnsMissingEmbedding('fake-embed', 10).length,
    ).toBe(0)
  })

  it('skips tool and system turns', async () => {
    const sess = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: sess.id, role: 'system', content: 'sys' })
    h.store.appendTurn({ sessionId: sess.id, role: 'tool', content: 'tool' })
    h.store.appendTurn({ sessionId: sess.id, role: 'user', content: 'real' })
    const provider = makeProvider()
    const indexer = new EmbeddingIndexer({
      store: h.store,
      provider,
      model: 'fake-embed',
      eventBus: h.bus,
    })
    const count = await indexer.drainOnce()
    expect(count).toBe(1)
    expect(provider.embedCalls).toEqual([['real']])
  })

  it('respects backfillBatch as the per-drain cap', async () => {
    const sess = h.store.createSession({ agentProfile: 'p' })
    for (let i = 0; i < 10; i++) {
      h.store.appendTurn({ sessionId: sess.id, role: 'user', content: `msg ${i}` })
    }
    const provider = makeProvider()
    const indexer = new EmbeddingIndexer({
      store: h.store,
      provider,
      model: 'fake-embed',
      eventBus: h.bus,
      batchSize: 3,
      backfillBatch: 5,
    })
    const count = await indexer.drainOnce()
    expect(count).toBe(5)
    expect(h.store.listTurnsMissingEmbedding('fake-embed', 10).length).toBe(5)
  })

  it('rejects mismatched embedding dimensions', async () => {
    const sess = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: sess.id, role: 'user', content: 'hi' })
    const provider: Provider = {
      id: 'wrong-dim',
      capabilities: { streaming: false, tools: false },
      async chat() {
        throw new Error('unused')
      },
      async *stream() {
        throw new Error('unused')
      },
      async embed(req) {
        return {
          model: req.model,
          embeddings: [[0.1, 0.2, 0.3]], // wrong dim
          tokens: 0,
        }
      },
    }
    const indexer = new EmbeddingIndexer({
      store: h.store,
      provider,
      model: 'wrong-dim',
      eventBus: h.bus,
    })
    await expect(indexer.drainOnce()).rejects.toThrow(/dim=3/)
  })

  it('emits embedding.indexed events with batch sizes', async () => {
    const sess = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: sess.id, role: 'user', content: 'x' })
    h.store.appendTurn({ sessionId: sess.id, role: 'assistant', content: 'y' })
    const provider = makeProvider()
    const indexer = new EmbeddingIndexer({
      store: h.store,
      provider,
      model: 'fake-embed',
      eventBus: h.bus,
    })
    await indexer.drainOnce()
    const indexed = h.events.filter((e) => e.type === 'embedding.indexed')
    expect(indexed.length).toBe(1)
    if (indexed[0].type === 'embedding.indexed') {
      expect(indexed[0].turnsIndexed).toBe(2)
    }
  })
})

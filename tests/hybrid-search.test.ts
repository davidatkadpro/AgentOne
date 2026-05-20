import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, packFloat32Vector, type Db } from '@/storage/db.js'
import {
  createConversationStore,
  EMBEDDING_DIM,
  type ConversationStore,
} from '@/storage/sqlite.js'
import { reciprocalRankFusion, buildHybridRecall } from '@/search/hybrid.js'
import type { Provider } from '@/providers/base.js'

function makeVec(seed: number): number[] {
  // Deterministic, lightly-varying vector; sufficient for ordering tests.
  const v = new Array(EMBEDDING_DIM).fill(0)
  v[seed % EMBEDDING_DIM] = 1
  return v
}

class FakeEmbedProvider implements Provider {
  readonly id = 'fake'
  readonly capabilities = { streaming: false, tools: false, embeddings: true }
  readonly calls: Array<string[]> = []
  constructor(private readonly vectorFor: (input: string) => number[]) {}
  async chat(): Promise<never> {
    throw new Error('not used')
  }
  async *stream(): AsyncIterable<never> {
    throw new Error('not used')
  }
  async embed(req: { input: string[] }): Promise<{
    model: string
    embeddings: number[][]
    tokens: number
  }> {
    this.calls.push(req.input)
    return {
      model: 'fake-embed',
      embeddings: req.input.map((s) => this.vectorFor(s)),
      tokens: 0,
    }
  }
}

describe('reciprocalRankFusion', () => {
  const hit = (id: string): ReturnType<typeof makeHit> => makeHit(id)
  function makeHit(turnId: string) {
    return {
      turnId,
      sessionId: 's',
      sessionTitle: null,
      role: 'user' as const,
      content: turnId,
      snippet: turnId,
      createdAt: 0,
      rank: 0,
    }
  }

  it('returns a single ranking unchanged for top-K', () => {
    const result = reciprocalRankFusion([[hit('a'), hit('b'), hit('c')]], 60, 10)
    expect(result.map((h) => h.turnId)).toEqual(['a', 'b', 'c'])
  })

  it('boosts items appearing in multiple rankings', () => {
    // 'b' is rank 2 in both — should outscore 'a' (rank 1 in only one).
    const result = reciprocalRankFusion(
      [
        [hit('a'), hit('b')],
        [hit('c'), hit('b')],
      ],
      60,
      10,
    )
    expect(result.map((h) => h.turnId)).toEqual(['b', 'a', 'c'])
  })

  it('preserves the FTS5 highlighted snippet when both retrievers match', () => {
    const ftsHit = { ...makeHit('a'), snippet: 'highlighted «match»' }
    const vecHit = { ...makeHit('a'), snippet: 'plain content' }
    const [merged] = reciprocalRankFusion([[ftsHit], [vecHit]], 60, 10)
    expect(merged.snippet).toBe('highlighted «match»')
  })

  it('clamps to limit', () => {
    const ranking = [hit('a'), hit('b'), hit('c'), hit('d')]
    const result = reciprocalRankFusion([ranking], 60, 2)
    expect(result.length).toBe(2)
  })

  it('emits a negative-score-as-rank so smaller rank = better hit', () => {
    const result = reciprocalRankFusion([[hit('a'), hit('b')]], 60, 10)
    expect(result[0].rank).toBeLessThan(result[1].rank)
  })
})

describe('buildHybridRecall', () => {
  let db: Db
  let store: ConversationStore
  beforeEach(() => {
    db = createDatabase({ path: ':memory:', skipMkdir: true })
    store = createConversationStore(db)
  })
  afterEach(() => {
    db.close()
  })

  function seed(content: string, role: 'user' | 'assistant' = 'user'): string {
    const sess = store.createSession({ agentProfile: 'p', title: null })
    const turn = store.appendTurn({ sessionId: sess.id, role, content })
    return turn.id
  }

  it('falls back to FTS5 when the provider has no embed()', async () => {
    seed('the platypus is a curious creature')
    const stub: Provider = {
      id: 'no-embed',
      capabilities: { streaming: false, tools: false },
      async chat() {
        throw new Error('unused')
      },
      async *stream() {
        throw new Error('unused')
      },
    }
    const recall = buildHybridRecall({
      store,
      provider: stub,
      embeddingModel: 'irrelevant',
    })
    const hits = await recall.searchHistory({ query: 'platypus' })
    expect(hits.length).toBe(1)
  })

  it('combines FTS5 and vector hits, surfacing both kinds in the merged list', async () => {
    // FTS5 will hit 'cosmic radiation' from query 'cosmic'.
    // Vector lane (forced via the fake provider) will return the other turn.
    const ftsTurn = seed('cosmic radiation in the upper atmosphere')
    const semanticTurn = seed('sky-borne particle showers from outer space')

    // Index both turns ahead of time so the vec table has rows.
    const vecForFts = makeVec(1)
    const vecForSem = makeVec(2)
    store.insertEmbedding({
      turnId: ftsTurn,
      embedding: packFloat32Vector(vecForFts),
      model: 'fake-embed',
      dim: EMBEDDING_DIM,
    })
    store.insertEmbedding({
      turnId: semanticTurn,
      embedding: packFloat32Vector(vecForSem),
      model: 'fake-embed',
      dim: EMBEDDING_DIM,
    })

    // Query vector matches the semantic turn most closely.
    const provider = new FakeEmbedProvider(() => vecForSem)
    const recall = buildHybridRecall({
      store,
      provider,
      embeddingModel: 'fake-embed',
    })

    const hits = await recall.searchHistory({ query: 'cosmic' })
    const ids = hits.map((h) => h.turnId)
    expect(ids).toContain(ftsTurn) // from FTS5
    expect(ids).toContain(semanticTurn) // from vector
    expect(provider.calls.length).toBe(1) // we embedded the query exactly once
  })

  it('tolerates a vector lane failure and still returns FTS5 hits', async () => {
    const turnId = seed('marsupials are weird and wonderful')
    const broken: Provider = {
      id: 'broken',
      capabilities: { streaming: false, tools: false, embeddings: true },
      async chat() {
        throw new Error('unused')
      },
      async *stream() {
        throw new Error('unused')
      },
      async embed() {
        throw new Error('embedding endpoint down')
      },
    }
    const recall = buildHybridRecall({
      store,
      provider: broken,
      embeddingModel: 'broken-model',
    })
    const hits = await recall.searchHistory({ query: 'marsupials' })
    expect(hits.map((h) => h.turnId)).toEqual([turnId])
  })
})

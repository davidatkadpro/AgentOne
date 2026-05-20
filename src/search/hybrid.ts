import type { Provider } from '../providers/base.js'
import type {
  ConversationStore,
  SearchTurnsOptions,
  TurnSearchHit,
} from '../storage/sqlite.js'
import { packFloat32Vector } from '../storage/db.js'
import type { EventBus } from '../core/events.js'

export interface HybridSearchConfig {
  store: ConversationStore
  provider: Provider
  embeddingModel: string
  /** Used to surface vector-lane failures so a silent degrade is observable. */
  eventBus?: EventBus
  /** RRF k parameter. Higher = flatter score curve. Cormack/Buettcher use 60. */
  rrfK?: number
  /** How many candidates to pull from each retriever before merging. Default 30. */
  perRetrieverCandidates?: number
}

export interface HybridRecall {
  searchHistory(opts: SearchTurnsOptions): Promise<TurnSearchHit[]>
}

/**
 * Reciprocal Rank Fusion: for each retriever, score every hit as 1/(k + rank).
 * Hits appearing in multiple retrievers sum their scores. Parameter-free
 * across the two retrievers' relative scales (FTS5 bm25 vs vec0 distance);
 * we only consult ranks, not raw scores.
 */
export function reciprocalRankFusion(
  rankings: TurnSearchHit[][],
  k: number,
  limit: number,
): TurnSearchHit[] {
  const scored = new Map<string, { hit: TurnSearchHit; score: number }>()
  for (const ranking of rankings) {
    ranking.forEach((hit, idx) => {
      const score = 1 / (k + idx + 1)
      const existing = scored.get(hit.turnId)
      if (existing) {
        existing.score += score
        // Prefer the FTS hit's snippet (highlighted) when both retrievers
        // matched — first ranking is treated as authoritative for display.
        if (rankings[0] === ranking && existing.hit.snippet !== hit.snippet) {
          existing.hit = { ...existing.hit, snippet: hit.snippet }
        }
      } else {
        scored.set(hit.turnId, { hit, score })
      }
    })
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ ...s.hit, rank: -s.score }))
}

/**
 * Build a recall layer that runs FTS5 + vector search in parallel and
 * fuses the rankings. Vector search is best-effort — if the embedding
 * provider is unavailable, we fall back to FTS5-only with a warning.
 */
export function buildHybridRecall(cfg: HybridSearchConfig): HybridRecall {
  const rrfK = cfg.rrfK ?? 60
  const candidates = cfg.perRetrieverCandidates ?? 30
  if (!cfg.provider.embed) {
    // No embeddings provider — degrade to FTS5 only.
    return {
      async searchHistory(opts) {
        return cfg.store.searchTurns({ ...opts, limit: opts.limit ?? 10 })
      },
    }
  }
  const embed = cfg.provider.embed.bind(cfg.provider)
  let lastVectorFailure: string | null = null
  return {
    async searchHistory(opts) {
      const limit = opts.limit ?? 10

      const ftsOpts: SearchTurnsOptions = { ...opts, limit: candidates, offset: 0 }
      const ftsHits = cfg.store.searchTurns(ftsOpts)

      let vecHits: TurnSearchHit[] = []
      try {
        const { embeddings } = await embed({
          model: cfg.embeddingModel,
          input: [opts.query],
        })
        if (embeddings[0]) {
          const vecOpts: Parameters<typeof cfg.store.vectorSearchTurns>[0] = {
            embedding: packFloat32Vector(embeddings[0]),
            k: candidates,
          }
          if (opts.sessionId !== undefined) vecOpts.sessionId = opts.sessionId
          if (opts.excludeSessionId !== undefined) vecOpts.excludeSessionId = opts.excludeSessionId
          if (opts.roles !== undefined) vecOpts.roles = opts.roles
          vecHits = cfg.store.vectorSearchTurns(vecOpts)
        }
        lastVectorFailure = null
      } catch (err) {
        // Best-effort: vector lane is optional. The agent still gets FTS5.
        // Emit at most one event per distinct failure message so a broken
        // embedding model is observable instead of silently degrading.
        const reason = err instanceof Error ? err.message : String(err)
        if (cfg.eventBus && reason !== lastVectorFailure) {
          lastVectorFailure = reason
          void cfg.eventBus.emit({
            type: 'embedding.failed',
            sessionId: null,
            reason: `hybrid recall: ${reason}`,
            ts: Date.now(),
          })
        }
        vecHits = []
      }

      const fused = reciprocalRankFusion([ftsHits, vecHits], rrfK, limit)
      // Apply offset post-merge so the agent can paginate over the fused list.
      const offset = opts.offset ?? 0
      return offset > 0 ? fused.slice(offset) : fused
    },
  }
}

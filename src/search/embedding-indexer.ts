import type { Provider } from '../providers/base.js'
import type { ConversationStore } from '../storage/sqlite.js'
import { EMBEDDING_DIM } from '../storage/sqlite.js'
import { packFloat32Vector } from '../storage/db.js'
import { EventBus } from '../core/events.js'

export interface EmbeddingIndexerConfig {
  store: ConversationStore
  provider: Provider
  /** Embedding model id to send with each provider.embed call. */
  model: string
  eventBus: EventBus
  /** How many turns to embed per provider call. Default 16. */
  batchSize?: number
  /** Backfill scan limit per tick. Default 64. */
  backfillBatch?: number
  /** Idle delay between drains when no new work arrives. Default 500ms. */
  idleMs?: number
}

/**
 * Async embedding index over `turns`. The indexer runs as a single background
 * loop: when a new turn is appended the orchestrator emits a hint via
 * `nudge()`; on bootstrap we backfill any turns missing the current model's
 * embedding. The chat path never blocks on this — failures are logged and
 * the loop continues.
 *
 * Backfill is bounded per tick (default 64) so a cold start against a long
 * conversation history doesn't starve other I/O on the LM Studio process.
 */
export class EmbeddingIndexer {
  private readonly batchSize: number
  private readonly backfillBatch: number
  private readonly idleMs: number
  private running = false
  private stopped = false
  private wakeResolver: (() => void) | null = null
  /** Set when a nudge arrives while a drain is in flight. Consumed at the
   *  top of the next loop iteration so the nudge isn't lost. */
  private pendingNudge = false
  private failureSignalled = false

  constructor(private readonly cfg: EmbeddingIndexerConfig) {
    this.batchSize = cfg.batchSize ?? 16
    this.backfillBatch = cfg.backfillBatch ?? 64
    this.idleMs = cfg.idleMs ?? 500
  }

  /** Kick the loop to drain work now (used after appendTurn). If the loop
   *  is currently inside a drain, the nudge is latched and consumed at the
   *  start of the next iteration so it isn't dropped. */
  nudge(): void {
    if (this.wakeResolver) {
      const r = this.wakeResolver
      this.wakeResolver = null
      r()
    } else {
      this.pendingNudge = true
    }
  }

  /** Start the background loop. Returns immediately. */
  start(): void {
    if (this.running) return
    this.running = true
    this.stopped = false
    void this.runLoop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.nudge()
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const indexed = await this.drainOnce()
        if (indexed === 0 && !this.pendingNudge) {
          await this.sleepUntilNudgeOrTimeout(this.idleMs)
        }
        // Consume any nudge that arrived during the drain so the next
        // iteration re-checks the queue immediately.
        this.pendingNudge = false
        this.failureSignalled = false
      } catch (err) {
        if (!this.failureSignalled) {
          this.failureSignalled = true
          await this.cfg.eventBus.emit({
            type: 'embedding.failed',
            sessionId: null,
            reason: err instanceof Error ? err.message : String(err),
            ts: Date.now(),
          })
        }
        // Back off after errors so we don't hammer a broken endpoint.
        this.pendingNudge = false
        await this.sleepUntilNudgeOrTimeout(Math.min(this.idleMs * 4, 5_000))
      }
    }
  }

  /** Embed up to `backfillBatch` pending turns. Returns the count indexed. */
  async drainOnce(): Promise<number> {
    let total = 0
    while (total < this.backfillBatch) {
      const pending = this.cfg.store.listTurnsMissingEmbedding(
        this.cfg.model,
        Math.min(this.batchSize, this.backfillBatch - total),
      )
      if (pending.length === 0) break
      if (!this.cfg.provider.embed) {
        throw new Error(
          `Embeddings requested but provider "${this.cfg.provider.id}" has no embed()`,
        )
      }
      const inputs = pending.map((t) => t.content)
      const { embeddings } = await this.cfg.provider.embed({
        model: this.cfg.model,
        input: inputs,
      })
      if (embeddings.length !== pending.length) {
        throw new Error(
          `embed() returned ${embeddings.length} vectors for ${pending.length} inputs`,
        )
      }
      const batchRows: Array<{
        turnId: string
        embedding: Buffer
        model: string
        dim: number
      }> = []
      for (let i = 0; i < pending.length; i++) {
        const vec = embeddings[i]
        if (vec.length !== EMBEDDING_DIM) {
          throw new Error(
            `Embedding model returned dim=${vec.length}, expected ${EMBEDDING_DIM}. Reconfigure the embedding profile or run a reindex.`,
          )
        }
        batchRows.push({
          turnId: pending[i].id,
          embedding: packFloat32Vector(vec),
          model: this.cfg.model,
          dim: EMBEDDING_DIM,
        })
      }
      // Single transaction for the whole batch — one fsync instead of N.
      this.cfg.store.insertEmbeddingsBatch(batchRows)
      total += pending.length
      await this.cfg.eventBus.emit({
        type: 'embedding.indexed',
        sessionId: null,
        turnsIndexed: pending.length,
        ts: Date.now(),
      })
    }
    return total
  }

  private sleepUntilNudgeOrTimeout(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.wakeResolver === wake) this.wakeResolver = null
        resolve()
      }, ms)
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.wakeResolver = wake
    })
  }
}

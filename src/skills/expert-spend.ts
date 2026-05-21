import type { ConversationStore } from '../storage/sqlite.js'

/**
 * Session-scoped tracker for cumulative expert spend. The `consult_expert`
 * tool checks `total` against the agent profile's `budgetPerSessionUsd`
 * before each call and records the actual reported cost after each call.
 *
 * Persistence is delegated to the ConversationStore's `expert_spend_v1`
 * ledger. The tracker's in-memory cache rehydrates from the ledger when it
 * is constructed for a resumed session — so budgets survive server restarts.
 *
 * Pass `store: null` to opt out of persistence (used by tests that don't
 * want a database side-effect for trivial spend assertions).
 */
export interface ExpertSpendTrackerConfig {
  sessionId: string
  store: ConversationStore | null
}

export class ExpertSpendTracker {
  private spentUsd = 0
  private callsByModel = new Map<string, { calls: number; usd: number }>()
  private readonly sessionId: string
  private readonly store: ConversationStore | null

  constructor(cfg: ExpertSpendTrackerConfig = { sessionId: '', store: null }) {
    this.sessionId = cfg.sessionId
    this.store = cfg.store
    if (this.store && this.sessionId) {
      for (const row of this.store.listExpertSpendForSession(this.sessionId)) {
        this.spentUsd += row.costUsd
        const entry = this.callsByModel.get(row.model) ?? { calls: 0, usd: 0 }
        entry.calls += 1
        entry.usd += row.costUsd
        this.callsByModel.set(row.model, entry)
      }
    }
  }

  get total(): number {
    return this.spentUsd
  }

  /** Per-model breakdown, useful for /cost and audit. */
  byModel(): Array<{ model: string; calls: number; usd: number }> {
    return [...this.callsByModel.entries()].map(([model, v]) => ({
      model,
      calls: v.calls,
      usd: v.usd,
    }))
  }

  /**
   * Record a successful expert call. Updates the in-memory cache and (if a
   * store was configured) appends a row to `expert_spend_v1`.
   *
   * `inputTokens` / `outputTokens` default to 0 for callers that only know
   * the cost.
   */
  add(
    model: string,
    usd: number,
    tokens: { inputTokens?: number; outputTokens?: number } = {},
  ): void {
    if (usd < 0 || !Number.isFinite(usd)) return
    this.spentUsd += usd
    const entry = this.callsByModel.get(model) ?? { calls: 0, usd: 0 }
    entry.calls += 1
    entry.usd += usd
    this.callsByModel.set(model, entry)
    if (this.store && this.sessionId) {
      this.store.appendExpertSpend({
        sessionId: this.sessionId,
        model,
        costUsd: usd,
        inputTokens: tokens.inputTokens ?? 0,
        outputTokens: tokens.outputTokens ?? 0,
      })
    }
  }
}

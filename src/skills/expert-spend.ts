/**
 * Session-scoped tracker for cumulative expert spend. The consult_expert tool
 * checks `total` against the agent profile's `budgetPerSessionUsd` before each
 * call and records the actual reported cost after each call.
 */
export class ExpertSpendTracker {
  private spentUsd = 0
  private callsByModel = new Map<string, { calls: number; usd: number }>()

  get total(): number {
    return this.spentUsd
  }

  /** Per-model breakdown, useful for /sessions UI and audit. */
  byModel(): Array<{ model: string; calls: number; usd: number }> {
    return [...this.callsByModel.entries()].map(([model, v]) => ({
      model,
      calls: v.calls,
      usd: v.usd,
    }))
  }

  add(model: string, usd: number): void {
    if (usd < 0 || !Number.isFinite(usd)) return
    this.spentUsd += usd
    const entry = this.callsByModel.get(model) ?? { calls: 0, usd: 0 }
    entry.calls += 1
    entry.usd += usd
    this.callsByModel.set(model, entry)
  }
}

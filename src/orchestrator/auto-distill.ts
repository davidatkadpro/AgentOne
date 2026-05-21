import type { ConversationStore } from '../storage/sqlite.js'
import { turnsToMessages } from '../storage/sqlite.js'
import type { WikiEngine } from '../memory/wiki/engine.js'
import type { Provider } from '../providers/base.js'
import type { EventBus } from '../core/events.js'
import { distill, renderDistilledMarkdown } from '../skills/distiller.js'

export interface AutoDistillConfig {
  enabled: boolean
  idleMinutes: number
  scanIntervalMinutes: number
}

export interface AutoDistillDeps {
  store: ConversationStore
  wiki: WikiEngine
  compressorProvider: Provider
  compressorModel: string
  eventBus: EventBus
  /** Override Date.now() for tests. */
  now?: () => number
}

/** Skip reasons mirror the `session.auto_distill_skipped` event variants. */
export type SkipReason =
  | 'no_turns'
  | 'too_short'
  | 'no_notes'
  | 'parse_failure'
  | 'already_distilled'
  | 'provider_error'

const MIN_TURNS_TO_DISTILL = 2

/**
 * Background scheduler that auto-runs `/distill` on sessions that have
 * been idle past the configured threshold. Tracks last activity per
 * session via event-bus subscriptions; periodically scans and triggers
 * distillation for eligible sessions.
 *
 * Idempotent by date: a session that's already been distilled today is
 * skipped on subsequent scans (the wiki page path includes the date, so
 * the WikiEngine would upsert anyway — we skip the LLM call to save
 * tokens, not to preserve content).
 */
export class AutoDistillScheduler {
  private lastActivity = new Map<string, number>()
  /** Sessions for which we've completed distillation today (path key). */
  private distilledToday = new Set<string>()
  private scanTimer: ReturnType<typeof setTimeout> | null = null
  private busUnsubs: Array<() => void> = []
  private running = false

  constructor(
    private readonly cfg: AutoDistillConfig,
    private readonly deps: AutoDistillDeps,
  ) {}

  /** Wire up bus subscriptions and prime lastActivity from the store. */
  start(): void {
    if (this.running) return
    if (!this.cfg.enabled) return
    this.running = true
    this.prime()
    this.busUnsubs.push(
      this.deps.eventBus.on('message.user.received', (e) => {
        this.recordActivity(e.sessionId, e.ts)
      }),
    )
    this.busUnsubs.push(
      this.deps.eventBus.on('message.assistant.completed', (e) => {
        this.recordActivity(e.sessionId, e.ts)
      }),
    )
    this.scheduleNextScan()
  }

  stop(): void {
    this.running = false
    for (const off of this.busUnsubs) off()
    this.busUnsubs = []
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
  }

  /** Public for tests — manually record activity. */
  recordActivity(sessionId: string, ts: number): void {
    this.lastActivity.set(sessionId, ts)
  }

  /**
   * Run one scan. Returns the list of sessions that were distilled this
   * tick. Pure-ish — uses `now` via cfg, no real timers. Exposed for tests.
   */
  async tick(now: number): Promise<{ distilled: string[]; skipped: Array<{ sessionId: string; reason: SkipReason }> }> {
    const distilled: string[] = []
    const skipped: Array<{ sessionId: string; reason: SkipReason }> = []
    const idleMs = this.cfg.idleMinutes * 60 * 1000
    const eligible: string[] = []
    for (const [sessionId, ts] of this.lastActivity) {
      if (now - ts >= idleMs) eligible.push(sessionId)
    }
    for (const sessionId of eligible) {
      const result = await this.tryDistill(sessionId, now)
      if (result === 'distilled') {
        distilled.push(sessionId)
        // Drop from activity map — already handled. A future message will
        // re-add it. This also prevents repeated scans from re-trying it
        // every tick once the distill succeeded.
        this.lastActivity.delete(sessionId)
      } else {
        skipped.push({ sessionId, reason: result })
        // Skips for non-fatal reasons (already_distilled) also drop the
        // session — there's nothing more we can do until activity resumes.
        // For parse/provider failures, drop too, so we don't keep retrying
        // a broken endpoint on every tick.
        this.lastActivity.delete(sessionId)
      }
    }
    return { distilled, skipped }
  }

  private async tryDistill(sessionId: string, now: number): Promise<'distilled' | SkipReason> {
    const dateSlug = new Date(now).toISOString().slice(0, 10)
    const draftKey = `${sessionId}|${dateSlug}`
    if (this.distilledToday.has(draftKey)) {
      await this.emitSkipped(sessionId, 'already_distilled', now)
      return 'already_distilled'
    }
    const session = this.deps.store.getSession(sessionId)
    if (!session) {
      await this.emitSkipped(sessionId, 'no_turns', now)
      return 'no_turns'
    }
    const turns = this.deps.store.listTurns(sessionId)
    if (turns.length === 0) {
      await this.emitSkipped(sessionId, 'no_turns', now)
      return 'no_turns'
    }
    if (turns.length < MIN_TURNS_TO_DISTILL) {
      await this.emitSkipped(sessionId, 'too_short', now)
      return 'too_short'
    }
    const toolCalls = this.deps.store.listToolCallsBySession(sessionId)
    const transcript = turnsToMessages(turns, toolCalls)

    let result
    try {
      result = await distill(transcript, this.deps.compressorProvider, this.deps.compressorModel)
    } catch {
      await this.emitSkipped(sessionId, 'provider_error', now)
      return 'provider_error'
    }
    if (result.notes.length === 0) {
      const reason: SkipReason = result.reparseUsed ? 'parse_failure' : 'no_notes'
      await this.emitSkipped(sessionId, reason, now)
      return reason
    }

    const draftPath = `drafts/distilled-${sessionId}-${dateSlug}`
    const markdown = renderDistilledMarkdown({
      sessionId,
      sessionTitle: session.title,
      notes: result.notes,
      generatedAt: new Date(now),
    })
    try {
      await this.deps.wiki.write(draftPath, markdown)
    } catch {
      await this.emitSkipped(sessionId, 'provider_error', now)
      return 'provider_error'
    }
    this.distilledToday.add(draftKey)
    await this.deps.eventBus.emit({
      type: 'session.auto_distilled',
      sessionId,
      notesCount: result.notes.length,
      draftPath: `${draftPath}.md`,
      ts: now,
    })
    return 'distilled'
  }

  private async emitSkipped(sessionId: string, reason: SkipReason, ts: number): Promise<void> {
    await this.deps.eventBus.emit({
      type: 'session.auto_distill_skipped',
      sessionId,
      reason,
      ts,
    })
  }

  /**
   * Seed lastActivity from the most recent turn in each existing session.
   * Without this, a sessions list that existed before server startup would
   * never get distilled — they'd be invisible until they emit a new event.
   */
  private prime(): void {
    const now = this.deps.now ? this.deps.now() : Date.now()
    for (const s of this.deps.store.listSessions()) {
      const turns = this.deps.store.listTurns(s.id)
      if (turns.length === 0) continue
      // listTurns returns ascending by createdAt — the last entry is most recent.
      const last = turns[turns.length - 1]
      this.lastActivity.set(s.id, last.createdAt ?? now)
    }
  }

  private scheduleNextScan(): void {
    const intervalMs = this.cfg.scanIntervalMinutes * 60 * 1000
    this.scanTimer = setTimeout(() => {
      void this.scanTimerFired()
    }, intervalMs)
  }

  private async scanTimerFired(): Promise<void> {
    if (!this.running) return
    try {
      const now = this.deps.now ? this.deps.now() : Date.now()
      await this.tick(now)
    } catch (err) {
      // Background loop — log but continue. Don't let one bad tick kill the
      // scheduler.
      // eslint-disable-next-line no-console
      console.error('[auto-distill] tick failed:', err)
    }
    if (this.running) this.scheduleNextScan()
  }
}

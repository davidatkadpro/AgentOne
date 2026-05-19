import type { Message, Role } from '../core/types.js'
import { countMessageTokens, countMessagesTokens } from '../core/tokenizer.js'
import { EventBus } from '../core/events.js'
import type { Provider } from '../providers/base.js'

export interface ContextManagerConfig {
  compressorProvider: Provider
  compressorModel: string
  contextWindow: number
  eventBus: EventBus
  /** Fraction of context_window at which compression fires. Default 0.8. */
  compressThreshold?: number
  /** Verbatim recency window kept after compression. Default 6. */
  recencyWindow?: number
}

export interface PrepareOptions {
  /**
   * Precomputed history token total. When provided, skips the encode pass over
   * the history (cached per-turn counts in the store are the source). When
   * absent, ContextManager re-encodes.
   */
  historyTokens?: number
}

export interface PreparedContext {
  messages: Message[]
  tokenCount: number
  compressed: boolean
}

const SUMMARY_HEADER = '[Summary of prior conversation]\n\n'
const RECOVERABILITY_HINT =
  '\n\n[Earlier turns omitted; recoverable via search_history when available.]'

const ROLE_LABEL: Record<Role, string> = {
  system: 'SYSTEM',
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
}

/**
 * Owns context-window management for a session.
 *
 *  - **Compression at 80%**: when (system + history) tokens exceed
 *    `compressThreshold * contextWindow`, the older turns are summarised by the
 *    compressor model and replaced with a synthetic system-role summary message.
 *    Last `recencyWindow` turns stay verbatim. On compressor failure, the
 *    prefix is dropped with an explicit "earlier turns dropped" note (the
 *    "fall back to aggressive truncation" rule from the PRD).
 *
 *  - Originals always live in the conversation store. This module only changes
 *    what is sent to the model.
 *
 * Per-message truncation (the 60% rule) is reserved for the tool-result path
 * which arrives with M3. It is intentionally not implemented in M1.
 */
export class ContextManager {
  private readonly compressThreshold: number
  private readonly recencyWindow: number
  private summaries = new Map<string, string>()

  constructor(private readonly cfg: ContextManagerConfig) {
    this.compressThreshold = cfg.compressThreshold ?? 0.8
    this.recencyWindow = cfg.recencyWindow ?? 6
  }

  async prepare(
    sessionId: string,
    system: Message,
    history: Message[],
    opts: PrepareOptions = {},
  ): Promise<PreparedContext> {
    const initial = [system, ...this.withSummary(sessionId, history)]
    const systemTokens = countMessageTokens(system) + this.summaryTokens(sessionId)
    const historyTokens = opts.historyTokens ?? countMessagesTokens(history)
    let total = systemTokens + historyTokens

    if (total <= this.compressThreshold * this.cfg.contextWindow) {
      // No compression — the initial assembly is what the model sees.
      // For accuracy when caller didn't pre-count, recount whole list.
      return {
        messages: initial,
        tokenCount: opts.historyTokens !== undefined ? total : countMessagesTokens(initial),
        compressed: false,
      }
    }

    const recency = await this.compress(sessionId, system, history)
    const finalMessages = [system, ...this.withSummary(sessionId, recency)]
    total = countMessagesTokens(finalMessages)
    return { messages: finalMessages, tokenCount: total, compressed: true }
  }

  reset(sessionId: string): void {
    this.summaries.delete(sessionId)
  }

  /** Test seam — exposes the stored summary text for a session, if any. */
  getSummary(sessionId: string): string | undefined {
    return this.summaries.get(sessionId)
  }

  private withSummary(sessionId: string, history: Message[]): Message[] {
    const summary = this.summaries.get(sessionId)
    if (!summary) return history
    return [{ role: 'system', content: summary }, ...history]
  }

  private summaryTokens(sessionId: string): number {
    const summary = this.summaries.get(sessionId)
    if (!summary) return 0
    return countMessageTokens({ role: 'system', content: summary })
  }

  private async compress(
    sessionId: string,
    system: Message,
    history: Message[],
  ): Promise<Message[]> {
    const splitAt = Math.max(0, history.length - this.recencyWindow)
    const toCompress = history.slice(0, splitAt)
    const recency = history.slice(splitAt)

    // History is shorter than recency window — nothing to compress; do not emit.
    if (toCompress.length === 0) return recency

    const tokensBefore = countMessagesTokens([system, ...this.withSummary(sessionId, history)])
    await this.cfg.eventBus.emit({
      type: 'context.compressing',
      sessionId,
      tokensBefore,
      ts: Date.now(),
    })

    let summaryBody: string | null = null
    try {
      summaryBody = await this.callCompressor(toCompress)
    } catch (err) {
      await this.cfg.eventBus.emit({
        type: 'context.compression_failed',
        sessionId,
        reason: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      })
    }

    // Replace, don't append: each compression supersedes the prior summary,
    // because the compressor saw the whole compressed prefix (which already
    // includes any previously-summarised content visible via withSummary).
    if (summaryBody) {
      this.summaries.set(
        sessionId,
        `${SUMMARY_HEADER}${summaryBody.trim()}${RECOVERABILITY_HINT}`,
      )
    } else {
      this.summaries.set(
        sessionId,
        `${SUMMARY_HEADER}[${toCompress.length} earlier turns dropped — compressor unavailable.]${RECOVERABILITY_HINT}`,
      )
    }

    const tokensAfter = countMessagesTokens([system, ...this.withSummary(sessionId, recency)])
    await this.cfg.eventBus.emit({
      type: 'context.compressed',
      sessionId,
      tokensBefore,
      tokensAfter,
      turnsCompressed: toCompress.length,
      ts: Date.now(),
    })

    return recency
  }

  private async callCompressor(toCompress: Message[]): Promise<string> {
    const transcript = toCompress
      .map((m) => `${ROLE_LABEL[m.role]}: ${m.content ?? ''}`)
      .join('\n\n')

    const res = await this.cfg.compressorProvider.chat({
      model: this.cfg.compressorModel,
      messages: [
        {
          role: 'system',
          content:
            'You compress conversations. Produce a terse prose summary of facts, decisions, and open questions. Preserve names, paths, and tool call outcomes verbatim. Do not include conversational filler.',
        },
        {
          role: 'user',
          content: `Summarise the following turns:\n\n${transcript}`,
        },
      ],
      temperature: 0.1,
      maxTokens: 800,
    })

    if (!res.content || res.content.trim().length === 0) {
      throw new Error('Compressor returned empty content')
    }
    return res.content
  }
}

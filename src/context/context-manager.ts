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
  /**
   * Per-message truncation threshold for tool results. A single tool
   * message whose token count exceeds `truncateThreshold * contextWindow`
   * is replaced with a head + tail + read_turn reference. Default 0.6
   * per PRD. Set to >= 1 to disable.
   */
  truncateThreshold?: number
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
  private readonly truncateThreshold: number
  private summaries = new Map<string, string>()

  constructor(private readonly cfg: ContextManagerConfig) {
    this.compressThreshold = cfg.compressThreshold ?? 0.8
    this.recencyWindow = cfg.recencyWindow ?? 6
    this.truncateThreshold = cfg.truncateThreshold ?? 0.6
  }

  async prepare(
    sessionId: string,
    system: Message,
    history: Message[],
    opts: PrepareOptions = {},
  ): Promise<PreparedContext> {
    // Per-message truncation first — a single oversized tool result must
    // not push the rest of the conversation over the compression threshold,
    // and compression wouldn't help anyway since compressors don't
    // summarise tool outputs verbatim. Mutates history in-place by mapping
    // to a new array.
    const truncatedHistory = this.truncateOversizedTools(sessionId, history)

    const initial = [system, ...this.withSummary(sessionId, truncatedHistory)]
    const systemTokens = countMessageTokens(system) + this.summaryTokens(sessionId)
    // Recount history if we truncated (passed-in historyTokens is stale).
    const historyChanged = truncatedHistory !== history
    const historyTokens = historyChanged
      ? countMessagesTokens(truncatedHistory)
      : opts.historyTokens ?? countMessagesTokens(history)
    let total = systemTokens + historyTokens

    if (total <= this.compressThreshold * this.cfg.contextWindow) {
      // No compression — the initial assembly is what the model sees.
      // For accuracy when caller didn't pre-count, recount whole list.
      return {
        messages: initial,
        tokenCount:
          opts.historyTokens !== undefined && !historyChanged
            ? total
            : countMessagesTokens(initial),
        compressed: false,
      }
    }

    const recency = await this.compress(sessionId, system, truncatedHistory)
    const finalMessages = [system, ...this.withSummary(sessionId, recency)]
    total = countMessagesTokens(finalMessages)
    return { messages: finalMessages, tokenCount: total, compressed: true }
  }

  /**
   * Apply the 60% rule (PRD #45): any tool-role message whose content
   * exceeds `truncateThreshold * contextWindow` tokens is replaced with
   * head + reference + tail. Emits `tool.result_truncated` per replacement.
   *
   * Pure transformation: returns the original array unchanged when no
   * message needed truncation, so callers can detect "no work happened"
   * via reference equality.
   */
  private truncateOversizedTools(sessionId: string, history: Message[]): Message[] {
    if (this.truncateThreshold >= 1) return history
    const maxTokens = Math.floor(this.truncateThreshold * this.cfg.contextWindow)
    let mutated = false
    const out = history.map((m) => {
      if (m.role !== 'tool' || !m.content) return m
      const tokens = countMessageTokens(m)
      if (tokens <= maxTokens) return m
      const newContent = truncateToolContent(m.content, m.tool_call_id ?? '?')
      const next: Message = { ...m, content: newContent }
      mutated = true
      void this.cfg.eventBus.emit({
        type: 'tool.result_truncated',
        sessionId,
        toolCallId: m.tool_call_id ?? '',
        tokensBefore: tokens,
        tokensAfter: countMessageTokens(next),
        ts: Date.now(),
      })
      return next
    })
    return mutated ? out : history
  }

  reset(sessionId: string): void {
    this.summaries.delete(sessionId)
  }

  /**
   * Force a compression now, ignoring the threshold. Used by /compact when the
   * user wants to free up context proactively. `changed` reports whether this
   * call actually compressed anything — when history fits within the recency
   * window, nothing happens and the caller can surface a "nothing to compact"
   * message instead of a misleading 0-token-saved event.
   */
  async compactNow(
    sessionId: string,
    system: Message,
    history: Message[],
  ): Promise<{ tokensBefore: number; tokensAfter: number; changed: boolean }> {
    const willCompress = history.length > this.recencyWindow
    const tokensBefore = countMessagesTokens([
      system,
      ...this.withSummary(sessionId, history),
    ])
    if (!willCompress) {
      return { tokensBefore, tokensAfter: tokensBefore, changed: false }
    }
    const recency = await this.compress(sessionId, system, history)
    const finalMessages = [system, ...this.withSummary(sessionId, recency)]
    const tokensAfter = countMessagesTokens(finalMessages)
    return { tokensBefore, tokensAfter, changed: true }
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
    const transcript = toCompress.map((m) => renderMessageForCompressor(m)).join('\n\n')

    const res = await this.cfg.compressorProvider.chat({
      model: this.cfg.compressorModel,
      messages: [
        {
          role: 'system',
          content:
            'You compress conversations. Produce a terse prose summary of facts, decisions, and open questions. ' +
            'Preserve names, paths, file references, and the agent\'s tool calls verbatim — when the transcript ' +
            'shows TOOL_CALL or TOOL_RESULT entries, include them as a structured "Tool log:" section at the end ' +
            'of the summary listing each call as `- <tool>(<short args>) -> <short result or status>`. ' +
            'Do not include conversational filler.',
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

/**
 * Render one message into the compressor's input transcript. Critically:
 * tool calls (on assistant messages) and tool results (role='tool') are
 * surfaced as structured TOOL_CALL / TOOL_RESULT lines so the compressor
 * has the data it needs to preserve them verbatim in the summary
 * (PRD #44).
 *
 * Exported for testing.
 */
export function renderMessageForCompressor(m: Message): string {
  const label = ROLE_LABEL[m.role]
  const lines: string[] = []
  // Render free-form content for user/assistant/system. Tool results use
  // the dedicated TOOL_RESULT line below so they get truncated for the
  // compressor's input window.
  if (m.role !== 'tool' && m.content && m.content.trim().length > 0) {
    lines.push(`${label}: ${m.content}`)
  }
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    for (const tc of m.tool_calls) {
      lines.push(
        `TOOL_CALL: ${tc.function.name}(${truncateForLog(tc.function.arguments, 240)}) [id=${tc.id}]`,
      )
    }
  }
  if (m.role === 'tool') {
    const id = m.tool_call_id ?? '?'
    const body = m.content ?? ''
    lines.push(`TOOL_RESULT[id=${id}]: ${truncateForLog(body, 480)}`)
  }
  return lines.join('\n')
}

function truncateForLog(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

/**
 * Head + reference + tail for an oversized tool result. The reference
 * names the tool_call_id so the agent can recover the full result via
 * read_turn. Character-based sizing is a heuristic — tokens-per-char
 * varies by content, but for tool outputs (mostly ASCII/code/JSON) it's
 * close to 4. Head ≈ tail ≈ 500 tokens (~2000 chars per PRD #45).
 *
 * Exported for testing.
 */
export function truncateToolContent(content: string, toolCallId: string): string {
  const HEAD_CHARS = 2000
  const TAIL_CHARS = 2000
  if (content.length <= HEAD_CHARS + TAIL_CHARS) return content
  const head = content.slice(0, HEAD_CHARS)
  const tail = content.slice(content.length - TAIL_CHARS)
  const omitted = content.length - HEAD_CHARS - TAIL_CHARS
  return (
    `${head}\n\n` +
    `[...truncated ${omitted} chars; call read_turn(id="${toolCallId}") to rehydrate the full result...]\n\n` +
    tail
  )
}

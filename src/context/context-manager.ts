import type { Message, Role } from '../core/types.js'
import { countMessageTokens, countMessagesTokens } from '../core/tokenizer.js'
import { EventBus } from '../core/events.js'
import type { Provider } from '../providers/base.js'

/**
 * Persistence hook for the compression watermark. The conversation store
 * implements this; tests can stub it. Optional in config so test cases
 * that exercise transient behaviour don't need to plumb a store.
 */
export interface CompressionStateStore {
  getCompressionState(sessionId: string): {
    summaryText: string
    throughTurnCount: number
  } | undefined
  saveCompressionState(input: {
    sessionId: string
    summaryText: string
    throughTurnCount: number
  }): void
  clearCompressionState(sessionId: string): void
}

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
  /**
   * Persistence backend for the per-session watermark. When omitted the
   * watermark lives in memory only and is lost on process restart —
   * leading to a full re-compression on the next user message after a
   * restart. Production wires the conversation store; tests can omit.
   */
  compressionStore?: CompressionStateStore
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
/**
 * Per-session compression state. `text` is the summary rendered into a
 * synthetic system message; `throughTurnCount` is the high-water mark
 * (counted in the caller-supplied history) of turns already folded into
 * the summary. The next `prepare` call slices `history.slice(throughTurnCount)`
 * so the same prefix isn't paid for again and doesn't keep re-tripping the
 * threshold.
 */
interface CompressionState {
  text: string
  throughTurnCount: number
}

export class ContextManager {
  private readonly compressThreshold: number
  private readonly recencyWindow: number
  private readonly truncateThreshold: number
  private summaries = new Map<string, CompressionState>()
  /** Sessions whose persisted state we've already pulled into the cache.
   *  Prevents repeated DB hits for sessions that have never been compressed. */
  private hydratedSessions = new Set<string>()

  constructor(private readonly cfg: ContextManagerConfig) {
    this.compressThreshold = cfg.compressThreshold ?? 0.8
    this.recencyWindow = cfg.recencyWindow ?? 6
    this.truncateThreshold = cfg.truncateThreshold ?? 0.6
  }

  /**
   * Read the compression state for a session, populating the in-memory
   * cache from the persistence store on first touch. Idempotent — once a
   * session is hydrated, subsequent calls hit the in-memory map only.
   */
  private getState(sessionId: string): CompressionState | undefined {
    if (!this.hydratedSessions.has(sessionId)) {
      this.hydratedSessions.add(sessionId)
      const persisted = this.cfg.compressionStore?.getCompressionState(sessionId)
      if (persisted) {
        this.summaries.set(sessionId, {
          text: persisted.summaryText,
          throughTurnCount: persisted.throughTurnCount,
        })
      }
    }
    return this.summaries.get(sessionId)
  }

  private setState(sessionId: string, state: CompressionState): void {
    this.summaries.set(sessionId, state)
    this.hydratedSessions.add(sessionId)
    this.cfg.compressionStore?.saveCompressionState({
      sessionId,
      summaryText: state.text,
      throughTurnCount: state.throughTurnCount,
    })
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

    // Drop the prefix already represented by the stored summary. Without
    // this, the caller (the orchestrator) reloads the full history from
    // the conversation store on every user message; we'd add the summary
    // on top of the same prefix and re-trip the threshold every turn.
    //
    // Defensive: if the caller hands us a history *shorter* than the
    // watermark (test code, a manual rewind, a fresh DB), fall back to
    // offset=0 and keep the summary attached to whatever was passed.
    // We can't slice past the end of the input.
    const entry = this.getState(sessionId)
    const offset =
      entry && entry.throughTurnCount <= truncatedHistory.length
        ? entry.throughTurnCount
        : 0
    const effectiveHistory =
      offset > 0 ? truncatedHistory.slice(offset) : truncatedHistory

    const initial = [system, ...this.withSummary(sessionId, effectiveHistory)]
    const systemTokens = countMessageTokens(system) + this.summaryTokens(sessionId)
    // Caller's historyTokens applies to the *full* history they passed.
    // After we slice off the compressed prefix, we have to recount.
    const historyChanged = truncatedHistory !== history
    const effectiveHistoryTokens =
      offset > 0 || historyChanged
        ? countMessagesTokens(effectiveHistory)
        : opts.historyTokens ?? countMessagesTokens(history)
    let total = systemTokens + effectiveHistoryTokens

    if (total <= this.compressThreshold * this.cfg.contextWindow) {
      // No compression — the initial assembly is what the model sees.
      // For accuracy when caller didn't pre-count, recount whole list.
      return {
        messages: initial,
        tokenCount:
          opts.historyTokens !== undefined && !historyChanged && offset === 0
            ? total
            : countMessagesTokens(initial),
        compressed: false,
      }
    }

    const recency = await this.compress(sessionId, system, effectiveHistory, offset)
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
    this.hydratedSessions.add(sessionId)
    this.cfg.compressionStore?.clearCompressionState(sessionId)
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
    // Same slice as prepare() so /compact doesn't double-summarise turns
    // already inside the existing summary.
    const entry = this.getState(sessionId)
    const offset =
      entry && entry.throughTurnCount <= history.length ? entry.throughTurnCount : 0
    const effectiveHistory = offset > 0 ? history.slice(offset) : history

    const willCompress = effectiveHistory.length > this.recencyWindow
    const tokensBefore = countMessagesTokens([
      system,
      ...this.withSummary(sessionId, effectiveHistory),
    ])
    if (!willCompress) {
      return { tokensBefore, tokensAfter: tokensBefore, changed: false }
    }
    const recency = await this.compress(sessionId, system, effectiveHistory, offset)
    const finalMessages = [system, ...this.withSummary(sessionId, recency)]
    const tokensAfter = countMessagesTokens(finalMessages)
    return { tokensBefore, tokensAfter, changed: true }
  }

  /** Test seam — exposes the stored summary text for a session, if any. */
  getSummary(sessionId: string): string | undefined {
    return this.getState(sessionId)?.text
  }

  /** Test seam — exposes the watermark for a session, if compressed. */
  getCompressionWatermark(sessionId: string): number | undefined {
    return this.getState(sessionId)?.throughTurnCount
  }

  private withSummary(sessionId: string, history: Message[]): Message[] {
    const entry = this.getState(sessionId)
    if (!entry) return history
    return [{ role: 'system', content: entry.text }, ...history]
  }

  private summaryTokens(sessionId: string): number {
    const entry = this.getState(sessionId)
    if (!entry) return 0
    return countMessageTokens({ role: 'system', content: entry.text })
  }

  /**
   * Compress the prefix of `effectiveHistory`. `priorOffset` is the
   * already-summarised count from the *caller's* (full) history — we add
   * the newly-compressed count to it so the next prepare slices correctly.
   *
   * When a prior summary exists, we pass it into the compressor so the
   * new summary can subsume it rather than dropping old context. Without
   * this, repeated compressions would lose the original prefix entirely.
   */
  private async compress(
    sessionId: string,
    system: Message,
    effectiveHistory: Message[],
    priorOffset: number,
  ): Promise<Message[]> {
    // Natural split point honouring the recency window. We then snap to a
    // safe seam so we never cut mid-task — see snapToSafeSplit. Without
    // this, `recency` could start with a `tool` result whose initiating
    // `assistant` (tool_calls) message ended up in `toCompress`, leaving
    // the model with an orphan tool message in its prompt. Strict
    // providers reject; lenient ones (LMStudio) often just return empty.
    let splitAt = Math.max(0, effectiveHistory.length - this.recencyWindow)
    splitAt = snapToSafeSplit(effectiveHistory, splitAt)
    const toCompress = effectiveHistory.slice(0, splitAt)
    const recency = effectiveHistory.slice(splitAt)

    // History is shorter than recency window — nothing to compress; do not emit.
    if (toCompress.length === 0) return recency

    const tokensBefore = countMessagesTokens([
      system,
      ...this.withSummary(sessionId, effectiveHistory),
    ])
    await this.cfg.eventBus.emit({
      type: 'context.compressing',
      sessionId,
      tokensBefore,
      ts: Date.now(),
    })

    const priorEntry = this.getState(sessionId)
    let summaryBody: string | null = null
    try {
      summaryBody = await this.callCompressor(toCompress, priorEntry?.text ?? null)
    } catch (err) {
      await this.cfg.eventBus.emit({
        type: 'context.compression_failed',
        sessionId,
        reason: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      })
    }

    const newThroughTurnCount = priorOffset + toCompress.length
    if (summaryBody) {
      this.setState(sessionId, {
        text: `${SUMMARY_HEADER}${summaryBody.trim()}${RECOVERABILITY_HINT}`,
        throughTurnCount: newThroughTurnCount,
      })
    } else {
      // Compressor unavailable — fall back to "earlier turns dropped" but
      // keep the watermark advancing so we don't loop on the same prefix.
      this.setState(sessionId, {
        text: `${SUMMARY_HEADER}[${newThroughTurnCount} earlier turns dropped — compressor unavailable.]${RECOVERABILITY_HINT}`,
        throughTurnCount: newThroughTurnCount,
      })
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

  private async callCompressor(
    toCompress: Message[],
    priorSummary: string | null,
  ): Promise<string> {
    const transcript = toCompress.map((m) => renderMessageForCompressor(m)).join('\n\n')

    const userPrompt = priorSummary
      ? `Existing summary of earlier turns (already folded in):\n\n${priorSummary}\n\n` +
        `New turns to fold into the summary:\n\n${transcript}\n\n` +
        `Produce an updated summary that subsumes both. Do not duplicate facts already in the existing summary; do not drop them either.`
      : `Summarise the following turns:\n\n${transcript}`

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
          content: userPrompt,
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
 * Snap a tentative split point in a message history to a `user`-message
 * boundary so neither side of the slice contains an orphaned tool message.
 *
 * Why: an agent task is `user → (assistant ± tool_calls → tool result)* →
 * final assistant`. If we cut mid-task, `recency[0]` can be a `tool`
 * message whose initiating `assistant(tool_calls)` is now in `toCompress`.
 * Many providers reject such messages outright; lenient ones (LMStudio)
 * accept them but the local model frequently responds with nothing,
 * leaving the user staring at "[The model produced no response]".
 *
 * Strategy: walk backward to find the nearest earlier user message
 * (= start of an agent task). Recency may grow larger than configured —
 * that's preferable to fracturing a tool call. If no earlier user
 * message exists, walk forward — the orchestrator just persisted the
 * latest user turn so this branch always succeeds in practice.
 *
 * Exported for testing.
 */
export function snapToSafeSplit(history: Message[], candidate: number): number {
  if (candidate <= 0) return 0
  if (candidate >= history.length) return history.length
  if (history[candidate]?.role === 'user') return candidate
  for (let i = candidate - 1; i >= 0; i--) {
    if (history[i]?.role === 'user') return i
  }
  for (let i = candidate + 1; i < history.length; i++) {
    if (history[i]?.role === 'user') return i
  }
  // No user message anywhere — leave the candidate. Compression in this
  // state is unusual and the caller can decide whether to bail.
  return candidate
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

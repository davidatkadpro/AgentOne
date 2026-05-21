/**
 * Stream-level companion to {@link parseHermesToolCalls}. The end-of-stream
 * parser handles the persisted/replayed content correctly, but the UI sees
 * deltas as they arrive — without filtering, the user briefly watches the
 * model type out `<tool_call><function=...>...</tool_call>` XML before it
 * vanishes from the persisted turn.
 *
 * This filter sits between the SSE parser and the consumer. Pass each
 * content delta through `push(delta)`; the returned strings are safe to
 * yield to the UI. The full assembled content is preserved in `assembled`
 * for downstream parsing.
 *
 * Suppression rules:
 *   - Everything from `<tool_call>` to `</tool_call>` (inclusive) is held back.
 *   - A trailing partial-open-tag prefix (e.g. the buffer ending with `<too`)
 *     is held back until either the tag completes or `flush()` confirms the
 *     stream ended without it being a real open.
 *   - Unclosed blocks at `flush()` are dropped entirely — they will never
 *     parse as a valid tool call, and surfacing half an XML block to the
 *     user is worse than showing nothing.
 */
const OPEN = '<tool_call>'
const CLOSE = '</tool_call>'

export class HermesStreamFilter {
  private buffer = ''
  /** Position in `buffer` we've already considered for yield/skip. */
  private cursor = 0
  /** True iff we're inside a `<tool_call>...` block waiting for the close. */
  private inBlock = false
  /** True iff flush() has dropped an unclosed block (for diagnostics). */
  private droppedUnclosed = false

  push(delta: string): string {
    if (delta.length === 0) return ''
    this.buffer += delta
    return this.drain()
  }

  /**
   * End of stream. Returns any remaining safe content (e.g. a trailing
   * partial open tag that never completed and is now known to be benign).
   */
  flush(): string {
    if (this.inBlock) {
      // Unclosed block: drop the unfinished suppression and don't surface
      // a half-rendered XML fragment to the UI.
      this.droppedUnclosed = true
      this.cursor = this.buffer.length
      return ''
    }
    // Yield whatever's still pending — partial-open-tag prefixes that never
    // completed into a real open are benign content.
    const out = this.buffer.slice(this.cursor)
    this.cursor = this.buffer.length
    return out
  }

  /** The full unfiltered content the model emitted, for the parser to scan. */
  get assembled(): string {
    return this.buffer
  }

  get hadUnclosedBlock(): boolean {
    return this.droppedUnclosed
  }

  private drain(): string {
    let out = ''
    // Loop because a single delta can both close one block and open another.
    // Bounded by buffer length; no risk of an infinite loop.
    for (;;) {
      if (!this.inBlock) {
        const openAt = this.buffer.indexOf(OPEN, this.cursor)
        if (openAt !== -1) {
          // Safe content runs up to the open tag; the tag itself is suppressed.
          out += this.buffer.slice(this.cursor, openAt)
          this.cursor = openAt
          this.inBlock = true
          continue
        }
        // No complete open tag — yield up to the last safe boundary, which is
        // before any trailing partial-open-tag prefix.
        const safeEnd = findSafeYieldBoundary(this.buffer, this.cursor)
        if (safeEnd > this.cursor) {
          out += this.buffer.slice(this.cursor, safeEnd)
          this.cursor = safeEnd
        }
        return out
      }
      // Inside a block — look for the close.
      const closeAt = this.buffer.indexOf(CLOSE, this.cursor)
      if (closeAt === -1) return out
      this.cursor = closeAt + CLOSE.length
      this.inBlock = false
    }
  }
}

/**
 * Largest position ≥ `from` such that `buf.slice(from, pos)` cannot contain
 * a partial `<tool_call>` open tag. In practice: if the suffix from the last
 * `<` is a strict prefix of OPEN, hold from that `<`; otherwise yield everything.
 */
function findSafeYieldBoundary(buf: string, from: number): number {
  const segment = buf.slice(from)
  const lastLt = segment.lastIndexOf('<')
  if (lastLt === -1) return buf.length
  const tail = segment.slice(lastLt)
  // A complete OPEN would have been handled by the indexOf above; here we
  // only need to guard against strict prefixes.
  if (tail.length < OPEN.length && OPEN.startsWith(tail)) {
    return from + lastLt
  }
  return buf.length
}

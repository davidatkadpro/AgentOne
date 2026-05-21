import type { WikiEngine } from '../memory/wiki/engine.js'
import type { HybridRecall } from '../search/hybrid.js'
import type { EventBus } from '../core/events.js'
import type { Message } from '../core/types.js'

export interface PassiveRecallConfig {
  /** When false, buildPassiveRecall always returns null without probing. */
  enabled: boolean
  /** Top-K wiki hits to include. 0 disables the wiki lane. */
  wikiHits: number
  /** Top-K cross-session history hits to include. 0 disables the history lane. */
  historyHits: number
  /** Per-snippet character cap. Keeps the injected block bounded. */
  maxCharsPerHit: number
}

export const DEFAULT_PASSIVE_RECALL: PassiveRecallConfig = {
  enabled: false,
  wikiHits: 2,
  historyHits: 2,
  maxCharsPerHit: 240,
}

export interface PassiveRecallSource {
  kind: 'wiki' | 'history'
  ref: string
  title: string
  snippet: string
}

export interface PassiveRecallResult {
  /** Markdown-formatted block to slot in as a system message. */
  block: string
  sources: PassiveRecallSource[]
}

export interface PassiveRecallDeps {
  wiki: WikiEngine
  recall: HybridRecall
  /** Current session, used as exclude_session_id for the history lane so
   *  the agent doesn't see its own ongoing turns echoed back. */
  sessionId: string
  /** Optional — emits a `recall.injected` event when a non-null result is
   *  produced. Lets the UI surface what was pulled in. */
  eventBus?: EventBus
}

/**
 * Probe the wiki + cross-session history for content related to the user's
 * latest message. Returns a formatted system-message-ready block, or null
 * when nothing relevant is found or the lane is disabled.
 *
 * Best-effort: any lane failure (wiki FTS parse error, vector lane down)
 * is swallowed — the user's turn must not block on a recall hiccup. The
 * other lane still gets a chance to contribute.
 */
export async function buildPassiveRecall(
  userMessage: string,
  cfg: PassiveRecallConfig,
  deps: PassiveRecallDeps,
): Promise<PassiveRecallResult | null> {
  if (!cfg.enabled) return null
  const trimmed = userMessage.trim()
  if (trimmed.length === 0) return null

  // The wiki search engine phrase-quotes its input, so passing the verbatim
  // user message ("What is the secret password?") looks for that literal
  // string and finds nothing. Build a disjunctive query from the distinctive
  // tokens (rare-words/proper-nouns) and use raw mode so FTS5 sees it as a
  // real boolean query. History search keeps the verbatim text — the hybrid
  // recall layer's RRF + vector lane handles long queries on its own.
  const fts = extractFtsQuery(trimmed)
  const wikiPromise =
    cfg.wikiHits > 0 && fts
      ? deps.wiki
          .search(fts, { limit: cfg.wikiHits, mode: 'raw' })
          .catch(() => [] as Array<{ path: string; name: string; snippet: string }>)
      : Promise.resolve([])

  const historyPromise =
    cfg.historyHits > 0
      ? deps.recall
          .searchHistory({
            query: trimmed,
            excludeSessionId: deps.sessionId,
            limit: cfg.historyHits,
          })
          .catch(() => [])
      : Promise.resolve([])

  const [wikiHits, historyHits] = await Promise.all([wikiPromise, historyPromise])

  const sources: PassiveRecallSource[] = []
  for (const h of wikiHits) {
    sources.push({
      kind: 'wiki',
      ref: h.path,
      title: h.name || h.path,
      snippet: truncate(h.snippet, cfg.maxCharsPerHit),
    })
  }
  for (const h of historyHits) {
    sources.push({
      kind: 'history',
      ref: `${h.sessionId}:${h.turnId}`,
      title: h.sessionTitle ?? 'untitled session',
      snippet: truncate(h.snippet || h.content, cfg.maxCharsPerHit),
    })
  }

  if (sources.length === 0) return null

  const block = formatBlock(sources)

  if (deps.eventBus) {
    void deps.eventBus.emit({
      type: 'recall.injected',
      sessionId: deps.sessionId,
      sources: sources.map((s) => ({ kind: s.kind, ref: s.ref, title: s.title })),
      ts: Date.now(),
    })
  }

  return { block, sources }
}

/** Convert a passive-recall result into the system message to prepend. */
export function recallToMessage(result: PassiveRecallResult): Message {
  return { role: 'system', content: result.block }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// English stopwords likely to appear in user messages. Not exhaustive — just
// the ones that would dominate an FTS5 OR query and add no signal.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its',
  'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'so', 'that', 'the',
  'them', 'they', 'this', 'to', 'us', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'yours', 'about', 'just', 'tell', 'please', 'find', 'show', 'give',
])

const MAX_TOKENS = 6

/**
 * Pull a small, FTS-friendly disjunctive query out of a natural-language
 * user message. We keep tokens that look distinctive (5+ chars, or
 * hyphenated, or capitalized mid-sentence), strip common stopwords, and
 * OR them together. Returns null if no usable tokens remain.
 *
 * Exported for testing — the heuristic is the kind of thing that benefits
 * from explicit examples in the test file.
 */
export function extractFtsQuery(message: string): string | null {
  // Replace FTS5 operator characters with whitespace so they can't break
  // out of token mode. We're constructing a real FTS expression — quoted
  // tokens with explicit OR — so stray punctuation needs to be neutralised.
  const cleaned = message.replace(/["()*]/g, ' ')
  const rawTokens = cleaned.split(/[\s.,;!?:/\\]+/).filter(Boolean)
  const scored: Array<{ token: string; score: number }> = []
  const seen = new Set<string>()
  for (const raw of rawTokens) {
    const lower = raw.toLowerCase()
    if (lower.length < 3) continue
    if (STOPWORDS.has(lower)) continue
    if (seen.has(lower)) continue
    seen.add(lower)
    // Crude distinctiveness: hyphenated > long > capitalized > everything else.
    let score = lower.length
    if (lower.includes('-')) score += 5
    if (/[A-Z]/.test(raw) && raw !== raw.toUpperCase()) score += 3
    scored.push({ token: lower, score })
  }
  if (scored.length === 0) return null
  const picked = scored.sort((a, b) => b.score - a.score).slice(0, MAX_TOKENS)
  // Quote each token so FTS5 treats it as a literal — protects against tokens
  // that happen to be FTS keywords (e.g. "near", "or"). Then OR them.
  return picked.map((p) => `"${p.token}"`).join(' OR ')
}

function formatBlock(sources: PassiveRecallSource[]): string {
  const parts: string[] = ['## Possibly relevant context']
  const wiki = sources.filter((s) => s.kind === 'wiki')
  const history = sources.filter((s) => s.kind === 'history')
  if (wiki.length > 0) {
    parts.push('From your wiki:')
    for (const s of wiki) parts.push(`- [${s.ref}] ${s.title} — ${s.snippet}`)
  }
  if (history.length > 0) {
    parts.push('From earlier conversations:')
    for (const s of history) parts.push(`- [session "${s.title}"] ${s.snippet}`)
  }
  parts.push('If any of this is relevant, cite the source. Otherwise ignore it.')
  return parts.join('\n')
}

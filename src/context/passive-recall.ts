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

  const wikiPromise =
    cfg.wikiHits > 0
      ? deps.wiki
          .search(trimmed, { limit: cfg.wikiHits })
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

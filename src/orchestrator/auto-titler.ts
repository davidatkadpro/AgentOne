import type { ConversationStore } from '../storage/sqlite.js'
import type { Provider } from '../providers/base.js'
import type { EventBus, EventByType } from '../core/events.js'

export interface AutoTitlerConfig {
  /** Title only after this many assistant turns. Default 3. */
  triggerAfterAssistantTurns?: number
  /** Max title length in chars. Default 64. */
  maxTitleChars?: number
}

export interface AutoTitlerDeps {
  store: ConversationStore
  titlerProvider: Provider
  titlerModel: string
  eventBus: EventBus
}

const DEFAULT_TRIGGER = 3
const DEFAULT_MAX_TITLE = 64

const TITLER_SYSTEM_PROMPT =
  'You write conversation titles. Given the first turns of a chat, produce a SHORT (3-8 word) title in title case that captures the topic. No quotation marks, no trailing punctuation, no "Conversation:" or "Re:" prefixes. Output ONLY the title — no explanation.'

/**
 * Background auto-titler: subscribes to assistant-completed events, and
 * when a session has accumulated enough turns AND has no title yet,
 * generates one via the configured titler provider.
 *
 * Trigger logic: title once the Nth assistant.completed fires for a
 * session. We re-check the store at fire-time (not from event count) so
 * we don't double-title across restarts that have replayed past events.
 *
 * Failures are silent: a flaky titler model must not break the chat.
 */
export class AutoTitler {
  private readonly trigger: number
  private readonly maxTitleChars: number
  /** Set of session ids we're currently titling, to dedupe concurrent fires. */
  private inFlight = new Set<string>()
  private unsubscribe: (() => void) | null = null

  constructor(cfg: AutoTitlerConfig, private readonly deps: AutoTitlerDeps) {
    this.trigger = cfg.triggerAfterAssistantTurns ?? DEFAULT_TRIGGER
    this.maxTitleChars = cfg.maxTitleChars ?? DEFAULT_MAX_TITLE
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.deps.eventBus.on(
      'message.assistant.completed',
      (e) => {
        // Fire-and-forget — never block the orchestrator.
        void this.maybeTitle(e)
      },
    )
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  /** Run one titling attempt. Exposed for tests so they can drive directly. */
  async maybeTitle(e: EventByType<'message.assistant.completed'>): Promise<void> {
    const sessionId = e.sessionId
    if (this.inFlight.has(sessionId)) return
    const session = this.deps.store.getSession(sessionId)
    if (!session) return
    if (session.title !== null) return // already titled (user-set or auto)

    const turns = this.deps.store.listTurns(sessionId)
    const assistantTurns = turns.filter((t) => t.role === 'assistant').length
    if (assistantTurns < this.trigger) return

    this.inFlight.add(sessionId)
    try {
      // Build a compact transcript of the first ~5 turns.
      const head = turns
        .filter((t) => t.role === 'user' || t.role === 'assistant')
        .slice(0, 5)
        .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
        .join('\n\n')

      const res = await this.deps.titlerProvider.chat({
        model: this.deps.titlerModel,
        messages: [
          { role: 'system', content: TITLER_SYSTEM_PROMPT },
          { role: 'user', content: `Title this chat:\n\n${head}` },
        ],
        temperature: 0.3,
        maxTokens: 32,
      })

      const cleaned = cleanTitle(res.content, this.maxTitleChars)
      if (!cleaned) return

      this.deps.store.setSessionTitle(sessionId, cleaned)
      await this.deps.eventBus.emit({
        type: 'session.titled',
        sessionId,
        title: cleaned,
        ts: Date.now(),
      })
    } catch {
      // Best-effort — never let a titler hiccup interfere with the chat.
    } finally {
      this.inFlight.delete(sessionId)
    }
  }
}

/**
 * Strip prefixes, quotes, trailing punctuation, then clamp. Exported for
 * tests — the cleaner is deterministic and easy to spec against.
 */
export function cleanTitle(raw: string, maxChars: number): string {
  let s = raw.trim()
  // Take only the first line FIRST — before we collapse newlines into
  // spaces. Otherwise "Line one\nLine two" becomes "Line one Line two".
  s = s.split('\n')[0]?.trim() ?? ''
  // Strip surrounding quotes.
  s = s.replace(/^["'`](.*)["'`]$/, '$1').trim()
  // Strip common prefixes.
  s = s.replace(/^(Title:|Conversation:|Chat:|Re:)\s*/i, '').trim()
  // Collapse internal whitespace and strip trailing punctuation.
  s = s.replace(/\s+/g, ' ').replace(/[.!?,:;]+$/, '').trim()
  if (s.length === 0) return ''
  if (s.length > maxChars) s = s.slice(0, maxChars).trim()
  return s
}

import { describe, it, expect, beforeEach } from 'vitest'
import { ContextManager } from '@/context/context-manager.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import type { Message } from '@/core/types.js'
import { FakeProvider, type FakeProviderOptions } from './fakes.js'

const SUMMARY_TEXT =
  'Prior turns established context X, decision Y, open question Z. Tool calls: none.'

function makeManager(opts?: {
  contextWindow?: number
  recencyWindow?: number
  compressorOpts?: FakeProviderOptions
}) {
  const bus = new EventBus()
  const events: AgentEvent[] = []
  bus.onAny((e) => {
    events.push(e)
  })

  const compressor = new FakeProvider(
    opts?.compressorOpts ?? { respond: () => SUMMARY_TEXT },
  )

  const cm = new ContextManager({
    compressorProvider: compressor,
    compressorModel: 'test-compressor',
    contextWindow: opts?.contextWindow ?? 1000,
    eventBus: bus,
    recencyWindow: opts?.recencyWindow ?? 2,
  })

  return { cm, bus, events, compressor }
}

function makeBigUserMessage(approxTokens: number): Message {
  // gpt-tokenizer averages ~1 token per ~4 chars in English.
  const text = 'A '.repeat(approxTokens * 2)
  return { role: 'user', content: text.trim() }
}

describe('ContextManager', () => {
  let system: Message
  beforeEach(() => {
    system = { role: 'system', content: 'You are AgentOne.' }
  })

  it('returns history unchanged when under the compression threshold', async () => {
    const { cm, events } = makeManager({ contextWindow: 10_000 })
    const history: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]
    const prepared = await cm.prepare('s1', system, history)

    expect(prepared.compressed).toBe(false)
    expect(prepared.messages).toEqual([system, ...history])
    expect(events.filter((e) => e.type === 'context.compressing')).toHaveLength(0)
  })

  it('compresses when total tokens exceed 80% of the window', async () => {
    const { cm, events, compressor } = makeManager({
      contextWindow: 1000,
      recencyWindow: 2,
    })

    const history: Message[] = []
    for (let i = 0; i < 6; i++) {
      history.push(makeBigUserMessage(200))
    }

    const prepared = await cm.prepare('s1', system, history)

    expect(prepared.compressed).toBe(true)
    expect(compressor.calls.length).toBe(1)

    // First message after system should be the summary (synthetic system role).
    expect(prepared.messages[0]).toBe(system)
    expect(prepared.messages[1]?.role).toBe('system')
    expect(prepared.messages[1]?.content).toContain('[Summary of prior conversation]')
    expect(prepared.messages[1]?.content).toContain(SUMMARY_TEXT)
    expect(prepared.messages[1]?.content).toContain('recoverable via search_history')

    // Last `recencyWindow` messages are preserved verbatim.
    const lastTwo = history.slice(-2)
    expect(prepared.messages.slice(-2)).toEqual(lastTwo)

    expect(events.some((e) => e.type === 'context.compressing')).toBe(true)
    const compressed = events.find((e) => e.type === 'context.compressed')
    expect(compressed).toBeDefined()
    if (compressed?.type === 'context.compressed') {
      expect(compressed.turnsCompressed).toBeGreaterThan(0)
      expect(compressed.tokensAfter).toBeLessThan(compressed.tokensBefore)
    }
  })

  it('falls back to a truncation-mode summary when the compressor fails', async () => {
    const { cm, events } = makeManager({
      contextWindow: 1000,
      recencyWindow: 2,
      compressorOpts: { failWith: new Error('compressor offline') },
    })

    const history: Message[] = []
    for (let i = 0; i < 6; i++) history.push(makeBigUserMessage(200))

    const prepared = await cm.prepare('s1', system, history)

    expect(prepared.compressed).toBe(true)
    expect(prepared.messages[1]?.content).toContain('earlier turns dropped')
    expect(events.some((e) => e.type === 'context.compression_failed')).toBe(true)
    expect(events.some((e) => e.type === 'context.compressed')).toBe(true)
  })

  it('treats an empty compressor response as a failure', async () => {
    const { cm, events } = makeManager({
      contextWindow: 1000,
      recencyWindow: 2,
      compressorOpts: { empty: true },
    })

    const history: Message[] = []
    for (let i = 0; i < 6; i++) history.push(makeBigUserMessage(200))

    const prepared = await cm.prepare('s1', system, history)

    expect(prepared.compressed).toBe(true)
    expect(prepared.messages[1]?.content).toContain('earlier turns dropped')
    expect(events.some((e) => e.type === 'context.compression_failed')).toBe(true)
  })

  it('summary text persists across subsequent prepare calls in the same session', async () => {
    const { cm } = makeManager({ contextWindow: 1000, recencyWindow: 2 })

    const history: Message[] = []
    for (let i = 0; i < 6; i++) history.push(makeBigUserMessage(200))

    await cm.prepare('s1', system, history)
    const stored = cm.getSummary('s1')
    expect(stored).toBeDefined()
    expect(stored).toContain(SUMMARY_TEXT)

    // Subsequent prepare with shorter history still includes the summary.
    const next = await cm.prepare('s1', system, [{ role: 'user', content: 'follow-up' }])
    expect(next.messages.some((m) => m.role === 'system' && m.content.includes(SUMMARY_TEXT))).toBe(
      true,
    )
  })

  it('reset clears stored summary for the session', async () => {
    const { cm } = makeManager({ contextWindow: 1000, recencyWindow: 2 })

    const history: Message[] = []
    for (let i = 0; i < 6; i++) history.push(makeBigUserMessage(200))

    await cm.prepare('s1', system, history)
    expect(cm.getSummary('s1')).toBeDefined()
    cm.reset('s1')
    expect(cm.getSummary('s1')).toBeUndefined()
  })
})

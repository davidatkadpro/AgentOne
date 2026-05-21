import { describe, it, expect, beforeEach } from 'vitest'
import {
  ContextManager,
  renderMessageForCompressor,
} from '@/context/context-manager.js'
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
    expect(
      next.messages.some(
        (m) => m.role === 'system' && (m.content ?? '').includes(SUMMARY_TEXT),
      ),
    ).toBe(true)
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

  describe('60% tool-result truncation', () => {
    it('replaces a tool message exceeding the threshold with head+ref+tail and emits tool.result_truncated', async () => {
      const { cm, events } = makeManager({ contextWindow: 1000 })
      // Build a tool result that's clearly over 60% of 1000 tokens (~600).
      // ~4 chars/token, so 10_000 chars ≈ 2500 tokens.
      const longResult = 'x'.repeat(10_000)
      const history: Message[] = [
        { role: 'user', content: 'do a thing' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 't', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'tc-1', content: longResult },
      ]
      const prepared = await cm.prepare('s1', system, history)

      const toolMessage = prepared.messages.find((m) => m.role === 'tool')!
      expect(toolMessage.content!.length).toBeLessThan(longResult.length)
      expect(toolMessage.content).toContain('truncated')
      expect(toolMessage.content).toContain('read_turn')
      expect(toolMessage.content).toContain('tc-1')

      const truncatedEvent = events.find((e) => e.type === 'tool.result_truncated')
      expect(truncatedEvent).toBeDefined()
      if (truncatedEvent?.type === 'tool.result_truncated') {
        expect(truncatedEvent.toolCallId).toBe('tc-1')
        expect(truncatedEvent.tokensAfter).toBeLessThan(truncatedEvent.tokensBefore)
      }
    })

    it('leaves small tool messages untouched', async () => {
      const { cm, events } = makeManager({ contextWindow: 10_000 })
      const small = 'short result'
      const history: Message[] = [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc-2', type: 'function', function: { name: 't', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'tc-2', content: small },
      ]
      const prepared = await cm.prepare('s1', system, history)
      const toolMessage = prepared.messages.find((m) => m.role === 'tool')!
      expect(toolMessage.content).toBe(small)
      expect(events.some((e) => e.type === 'tool.result_truncated')).toBe(false)
    })

    it('never truncates user or assistant messages even when oversized', async () => {
      const { cm, events } = makeManager({ contextWindow: 1000 })
      const longUser = 'u'.repeat(10_000)
      const longAssistant = 'a'.repeat(10_000)
      const history: Message[] = [
        { role: 'user', content: longUser },
        { role: 'assistant', content: longAssistant },
      ]
      const prepared = await cm.prepare('s1', system, history)
      // User and assistant messages keep their original content even though
      // compression may have replaced them with a summary — find the verbatim
      // tail. If compression fired, recency window of 2 keeps them.
      const userMsg = prepared.messages.find((m) => m.role === 'user')
      const assistantMsg = prepared.messages.find((m) => m.role === 'assistant')
      // The 60%-rule's tool.result_truncated event must not fire for non-tool roles.
      expect(events.some((e) => e.type === 'tool.result_truncated')).toBe(false)
      // And neither message ever got the truncation marker.
      if (userMsg) expect(userMsg.content).not.toContain('read_turn')
      if (assistantMsg) expect(assistantMsg.content).not.toContain('read_turn')
    })

    it('renders tool calls + results as structured lines for the compressor (PRD #44)', () => {
      const assistantWithToolCall: Message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tc-abc',
            type: 'function',
            function: { name: 'wiki_read', arguments: '{"path":"x"}' },
          },
        ],
      }
      const toolResult: Message = {
        role: 'tool',
        tool_call_id: 'tc-abc',
        content: '{"ok":true,"value":{"body":"page content"}}',
      }
      const a = renderMessageForCompressor(assistantWithToolCall)
      const t = renderMessageForCompressor(toolResult)
      // Tool call info reaches the compressor — id, name, and args.
      expect(a).toContain('TOOL_CALL: wiki_read')
      expect(a).toContain('tc-abc')
      // Tool result is associated back to the call id.
      expect(t).toContain('TOOL_RESULT')
      expect(t).toContain('tc-abc')
      expect(t).toContain('page content')
    })

    it('truncates very long tool results in the compressor input', () => {
      const huge = 'x'.repeat(10_000)
      const out = renderMessageForCompressor({
        role: 'tool',
        tool_call_id: 'tc-1',
        content: huge,
      })
      expect(out.length).toBeLessThan(huge.length / 2)
      expect(out).toContain('…') // truncation marker
    })

    it('honours truncateThreshold >= 1 as "disabled"', async () => {
      const bus = new EventBus()
      const events: AgentEvent[] = []
      bus.onAny((e) => {
        events.push(e)
      })
      const cm = new ContextManager({
        compressorProvider: new FakeProvider({ respond: () => SUMMARY_TEXT }),
        compressorModel: 'c',
        contextWindow: 1000,
        eventBus: bus,
        truncateThreshold: 1,
      })
      const longResult = 'x'.repeat(10_000)
      const history: Message[] = [
        { role: 'user', content: 'q' },
        { role: 'tool', tool_call_id: 'tc-3', content: longResult },
      ]
      const prepared = await cm.prepare('s1', system, history)
      const toolMessage = prepared.messages.find((m) => m.role === 'tool')!
      expect(toolMessage.content).toBe(longResult)
      expect(events.some((e) => e.type === 'tool.result_truncated')).toBe(false)
    })
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import {
  ContextManager,
  renderMessageForCompressor,
  snapToSafeSplit,
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

  describe('does not re-compress an already-summarised prefix (the original bug)', () => {
    it('compressor is called exactly once when prepare is invoked twice with a growing history', async () => {
      // The orchestrator reloads the full conversation from the store on
      // every user message. Without the compression watermark, the summary
      // gets stacked on top of the same prefix every turn and trips the
      // threshold again — the user sees compression after every message.
      //
      // contextWindow chosen so the post-compression assembly (system +
      // summary + recency window + small new turns) sits comfortably under
      // the threshold. The bug was that pre-fix logic ignored this and
      // re-counted the whole prefix every turn.
      const { cm, compressor, events } = makeManager({
        contextWindow: 4000,
        recencyWindow: 2,
      })

      const history: Message[] = []
      for (let i = 0; i < 10; i++) history.push(makeBigUserMessage(200))

      const first = await cm.prepare('s1', system, history)
      expect(first.compressed).toBe(true)
      expect(compressor.calls.length).toBe(1)

      // Simulate the next user turn: orchestrator reloads the full
      // history from the store and appends a couple of new (modest)
      // turns. Pre-fix, this would re-trigger compression because the
      // summary got stacked on top of the same 6-message prefix.
      history.push({ role: 'assistant', content: 'short response' })
      history.push({ role: 'user', content: 'follow-up' })

      const second = await cm.prepare('s1', system, history)

      // The fix: prefix already covered by the summary is sliced off, so
      // total tokens are well under the threshold and no second compress
      // call happens — even though the caller passed the full 8-message
      // history.
      expect(second.compressed).toBe(false)
      expect(compressor.calls.length).toBe(1)
      // We should still see the summary attached to the (now shorter)
      // tail in the messages sent to the model.
      expect(
        second.messages.some(
          (m) => m.role === 'system' && (m.content ?? '').includes(SUMMARY_TEXT),
        ),
      ).toBe(true)
      // Only one context.compressed event total across both prepare calls.
      expect(events.filter((e) => e.type === 'context.compressed')).toHaveLength(1)
    })

    it('records a watermark equal to the number of turns rolled into the summary', async () => {
      const { cm } = makeManager({ contextWindow: 1000, recencyWindow: 2 })
      const history: Message[] = []
      for (let i = 0; i < 6; i++) history.push(makeBigUserMessage(200))
      await cm.prepare('s1', system, history)
      // 6 turns total, recencyWindow=2 → 4 turns folded into summary.
      expect(cm.getCompressionWatermark('s1')).toBe(4)
    })

    it('eventually compresses again once enough new turns accumulate past the watermark', async () => {
      const { cm, compressor } = makeManager({
        contextWindow: 1000,
        recencyWindow: 2,
      })
      const history: Message[] = []
      for (let i = 0; i < 6; i++) history.push(makeBigUserMessage(200))
      await cm.prepare('s1', system, history)
      expect(compressor.calls.length).toBe(1)
      expect(cm.getCompressionWatermark('s1')).toBe(4)

      // Append enough big turns that the *post-watermark* slice itself
      // exceeds the threshold.
      for (let i = 0; i < 6; i++) history.push(makeBigUserMessage(200))
      await cm.prepare('s1', system, history)

      expect(compressor.calls.length).toBe(2)
      // Watermark advanced: 4 (initial) + (post-slice toCompress count).
      const wm = cm.getCompressionWatermark('s1')
      expect(wm).toBeGreaterThan(4)
    })

    it('passes the prior summary into the compressor on subsequent compressions', async () => {
      const { cm, compressor } = makeManager({
        contextWindow: 1000,
        recencyWindow: 2,
      })
      const history: Message[] = []
      for (let i = 0; i < 6; i++) history.push(makeBigUserMessage(200))
      await cm.prepare('s1', system, history)
      // Force a second compression by extending history past the threshold.
      for (let i = 0; i < 6; i++) history.push(makeBigUserMessage(200))
      await cm.prepare('s1', system, history)

      expect(compressor.calls.length).toBe(2)
      // The second compressor call should contain the prior summary in
      // its user prompt so old context isn't dropped.
      const secondCall = compressor.calls[1]!
      const userMsg = secondCall.messages.find((m) => m.role === 'user')
      expect(userMsg?.content).toContain('Existing summary of earlier turns')
    })
  })

  describe('compression slice respects tool-call boundaries', () => {
    // The original bug: compress() did a blunt slice at `history.length -
    // recencyWindow`. If that landed inside an agent task (between an
    // assistant's tool_calls and the tool result), `recency` began with an
    // orphan tool message. Local models (LMStudio) silently returned ""
    // rather than erroring, surfacing as "[The model produced no response]"
    // in the UI.

    function makeHistory(): Message[] {
      // Realistic shape: user → assistant+tool_call → tool → assistant
      return [
        { role: 'user', content: 'u1' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'tc1', content: 'result1' },
        { role: 'assistant', content: 'answer 1' },
        { role: 'user', content: 'u2' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc2', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'tc2', content: 'result2' },
        { role: 'assistant', content: 'answer 2' },
        { role: 'user', content: 'u3' },
      ]
    }

    it('snaps a candidate that lands on a tool message backward to a user boundary', () => {
      const h = makeHistory()
      // Index 2 is a tool result — orphan if we cut here.
      expect(h[2]?.role).toBe('tool')
      expect(snapToSafeSplit(h, 2)).toBe(0) // back to u1
    })

    it('snaps a candidate landing on an assistant-with-tool_calls backward', () => {
      const h = makeHistory()
      // Index 5 is assistant with tool_calls — if we cut here, tc2 result
      // ends up in recency without its assistant parent... wait no, the
      // assistant IS the parent and would be in toCompress. The dangerous
      // case is index 6 (tool result), but assistants-with-calls are also
      // best treated as task-start. We snap back to u2 for symmetry.
      expect(snapToSafeSplit(h, 5)).toBe(4)
    })

    it('keeps a candidate that already sits on a user boundary', () => {
      const h = makeHistory()
      expect(h[4]?.role).toBe('user')
      expect(snapToSafeSplit(h, 4)).toBe(4)
    })

    it('walks forward when no earlier user message exists', () => {
      const h: Message[] = [
        { role: 'tool', tool_call_id: 'tc0', content: 'orphan' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'u' },
      ]
      expect(snapToSafeSplit(h, 0)).toBe(0) // candidate=0 returns 0
      expect(snapToSafeSplit(h, 1)).toBe(2) // walk forward, no earlier user
    })

    it('returns candidate unchanged when history has no user messages at all', () => {
      const h: Message[] = [
        { role: 'assistant', content: 'a1' },
        { role: 'tool', tool_call_id: 'tc', content: 'r' },
      ]
      expect(snapToSafeSplit(h, 1)).toBe(1)
    })

    it('end-to-end: compression never leaves an orphan tool at recency[0]', async () => {
      const { cm, compressor } = makeManager({
        contextWindow: 600, // small window forces compression
        recencyWindow: 3, // configured small to bias the natural cut into a tool cluster
      })

      const big = (s: string) => ({ role: 'user' as const, content: s + 'x'.repeat(800) })
      const bigAns = (s: string) => ({
        role: 'assistant' as const,
        content: s + 'x'.repeat(800),
      })
      const history: Message[] = [
        big('u1 '),
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'tc1', content: 'r1' },
        bigAns('a1 '),
        big('u2 '),
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc2', type: 'function', function: { name: 'f', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'tc2', content: 'r2' },
        bigAns('a2 '),
        { role: 'user', content: 'u3' },
      ]

      const prepared = await cm.prepare('s1', system, history)
      expect(prepared.compressed).toBe(true)
      expect(compressor.calls.length).toBe(1)

      // The first message after [system, summary] must NOT be a `tool`.
      // Find the first non-system message.
      const nonSystem = prepared.messages.find((m) => m.role !== 'system')
      expect(nonSystem?.role).not.toBe('tool')
    })
  })

  describe('compression watermark persistence', () => {
    // The in-memory watermark dies with the process. Without a persistence
    // store, every restart re-runs compression on the full conversation
    // prefix at the next user message — burning the compressor model
    // and (in practice) yielding an empty response when the recency
    // slice landed mid-tool-call.

    interface PersistedRow {
      summaryText: string
      throughTurnCount: number
    }

    function makeStubStore() {
      const map = new Map<string, PersistedRow>()
      const calls = { save: 0, get: 0, clear: 0 }
      return {
        map,
        calls,
        getCompressionState(sessionId: string) {
          calls.get += 1
          const row = map.get(sessionId)
          return row ? { ...row } : undefined
        },
        saveCompressionState(input: {
          sessionId: string
          summaryText: string
          throughTurnCount: number
        }) {
          calls.save += 1
          map.set(input.sessionId, {
            summaryText: input.summaryText,
            throughTurnCount: input.throughTurnCount,
          })
        },
        clearCompressionState(sessionId: string) {
          calls.clear += 1
          map.delete(sessionId)
        },
      }
    }

    it('writes watermark + summary to the store after compression', async () => {
      const store = makeStubStore()
      const bus = new EventBus()
      const compressor = new FakeProvider({ respond: () => SUMMARY_TEXT })
      const cm = new ContextManager({
        compressorProvider: compressor,
        compressorModel: 'c',
        contextWindow: 4000,
        eventBus: bus,
        recencyWindow: 2,
        compressionStore: store,
      })
      const history: Message[] = []
      for (let i = 0; i < 10; i++) history.push(makeBigUserMessage(200))
      await cm.prepare('s1', system, history)

      expect(store.calls.save).toBe(1)
      const row = store.map.get('s1')
      expect(row).toBeDefined()
      expect(row?.throughTurnCount).toBe(8) // 10 - recencyWindow=2
      expect(row?.summaryText).toContain(SUMMARY_TEXT)
    })

    it('hydrates watermark from the store on first prepare (simulates process restart)', async () => {
      const store = makeStubStore()
      // Pretend a previous process compressed this session and persisted state.
      store.map.set('s1', {
        summaryText: '[Summary of prior conversation]\n\nseeded\n',
        throughTurnCount: 8,
      })

      const bus = new EventBus()
      const compressor = new FakeProvider({ respond: () => SUMMARY_TEXT })
      const cm = new ContextManager({
        compressorProvider: compressor,
        compressorModel: 'c',
        contextWindow: 4000,
        eventBus: bus,
        recencyWindow: 2,
        compressionStore: store,
      })

      // Simulate "the orchestrator reloaded full history from the DB" —
      // 10 messages, but 8 were already folded into the summary.
      const history: Message[] = []
      for (let i = 0; i < 10; i++) history.push(makeBigUserMessage(200))
      const prepared = await cm.prepare('s1', system, history)

      // Compressor must not have been called — the watermark told us to
      // slice off 8 turns; effective history is the last 2 only.
      expect(compressor.calls.length).toBe(0)
      expect(prepared.compressed).toBe(false)
      // The summary text should be the seeded one, not a fresh roll.
      expect(
        prepared.messages.some(
          (m) => m.role === 'system' && (m.content ?? '').includes('seeded'),
        ),
      ).toBe(true)
      // Watermark exposed via test seam — proves hydration ran.
      expect(cm.getCompressionWatermark('s1')).toBe(8)
    })

    it('reset clears persisted state too', async () => {
      const store = makeStubStore()
      store.map.set('s1', {
        summaryText: 'persisted',
        throughTurnCount: 3,
      })
      const bus = new EventBus()
      const cm = new ContextManager({
        compressorProvider: new FakeProvider({ respond: () => SUMMARY_TEXT }),
        compressorModel: 'c',
        contextWindow: 4000,
        eventBus: bus,
        compressionStore: store,
      })
      cm.reset('s1')
      expect(store.map.has('s1')).toBe(false)
      expect(store.calls.clear).toBe(1)
    })

    it('still works when no compressionStore is provided (transient mode)', async () => {
      const bus = new EventBus()
      const compressor = new FakeProvider({ respond: () => SUMMARY_TEXT })
      const cm = new ContextManager({
        compressorProvider: compressor,
        compressorModel: 'c',
        contextWindow: 4000,
        eventBus: bus,
        recencyWindow: 2,
        // no compressionStore
      })
      const history: Message[] = []
      for (let i = 0; i < 10; i++) history.push(makeBigUserMessage(200))
      await cm.prepare('s1', system, history)
      expect(cm.getCompressionWatermark('s1')).toBe(8)
    })
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

import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStreamStore } from '@/stores/session-stream'

const SID = '11111111-1111-1111-1111-111111111111'

describe('session-stream store', () => {
  beforeEach(() => {
    // Reset all sessions between tests.
    const all = Object.keys(useSessionStreamStore.getState().byId)
    for (const id of all) useSessionStreamStore.getState().drop(id)
    useSessionStreamStore.getState().ensure(SID)
  })

  it('handles streaming delta → completed lifecycle', () => {
    const store = useSessionStreamStore.getState()
    store.applyEvent({ type: 'message.assistant.started', sessionId: SID, turnId: 't1', ts: 1 } as never)
    store.applyEvent({ type: 'message.assistant.delta', sessionId: SID, turnId: 't1', delta: 'Hello ' } as never)
    store.applyEvent({ type: 'message.assistant.delta', sessionId: SID, turnId: 't1', delta: 'world' } as never)
    expect(useSessionStreamStore.getState().byId[SID]?.activeAssistant?.text).toBe('Hello world')

    store.applyEvent({
      type: 'message.assistant.completed',
      sessionId: SID,
      turnId: 't1',
      inputTokens: 5,
      outputTokens: 2,
      ts: 2,
    } as never)
    const after = useSessionStreamStore.getState().byId[SID]
    expect(after?.activeAssistant).toBeNull()
    expect(after?.turns).toHaveLength(1)
    expect(after?.turns[0]?.content).toBe('Hello world')
  })

  it('tracks tool chips through pending → done', () => {
    const store = useSessionStreamStore.getState()
    store.applyEvent({ type: 'message.assistant.started', sessionId: SID, turnId: 't1', ts: 1 } as never)
    store.applyEvent({
      type: 'tool.called',
      sessionId: SID,
      turnId: 't1',
      toolCallId: 'tc1',
      tool: 'fs.read',
      args: {},
      ts: 2,
    } as never)
    expect(useSessionStreamStore.getState().byId[SID]?.activeAssistant?.toolChips['tc1']?.status).toBe('pending')

    store.applyEvent({
      type: 'tool.completed',
      sessionId: SID,
      turnId: 't1',
      toolCallId: 'tc1',
      tool: 'fs.read',
      ok: true,
      durationMs: 123,
      ts: 3,
    } as never)
    expect(useSessionStreamStore.getState().byId[SID]?.activeAssistant?.toolChips['tc1']).toEqual({
      toolCallId: 'tc1',
      tool: 'fs.read',
      status: 'done',
      durationMs: 123,
      args: {},
    })
  })

  it('tracks failed tools and pushes a meta row', () => {
    const store = useSessionStreamStore.getState()
    store.applyEvent({ type: 'message.assistant.started', sessionId: SID, turnId: 't1', ts: 1 } as never)
    store.applyEvent({
      type: 'tool.called',
      sessionId: SID,
      turnId: 't1',
      toolCallId: 'tc1',
      tool: 'fs.read',
      args: {},
      ts: 2,
    } as never)
    store.applyEvent({
      type: 'tool.failed',
      sessionId: SID,
      turnId: 't1',
      toolCallId: 'tc1',
      tool: 'fs.read',
      code: 'EACCES',
      message: 'permission denied',
      ts: 3,
    } as never)
    const s = useSessionStreamStore.getState().byId[SID]
    expect(s?.activeAssistant?.toolChips['tc1']?.status).toBe('failed')
    expect(s?.metaRows.some((m) => m.kind === 'error')).toBe(true)
  })

  it('marks awaiting_input on session.awaiting_input', () => {
    const store = useSessionStreamStore.getState()
    store.applyEvent({
      type: 'session.awaiting_input',
      sessionId: SID,
      notificationId: 7,
      question: 'Yes or no?',
      ts: 1,
    } as never)
    expect(useSessionStreamStore.getState().byId[SID]?.awaitingInput).toEqual({
      notificationId: 7,
      question: 'Yes or no?',
    })
  })

  it('moves activeAssistant text into a turn on cancellation', () => {
    const store = useSessionStreamStore.getState()
    store.applyEvent({ type: 'message.assistant.started', sessionId: SID, turnId: 't1', ts: 1 } as never)
    store.applyEvent({ type: 'message.assistant.delta', sessionId: SID, turnId: 't1', delta: 'partial' } as never)
    store.applyEvent({ type: 'turn.cancel_requested', sessionId: SID, ts: 2 } as never)
    store.applyEvent({ type: 'turn.cancelled', sessionId: SID, kind: 'soft', ts: 3 } as never)
    const after = useSessionStreamStore.getState().byId[SID]
    expect(after?.activeAssistant).toBeNull()
    expect(after?.cancelRequested).toBe(false)
    expect(after?.turns[0]?.content).toBe('partial')
  })

  it('optimistically appends a user turn then removes on error', () => {
    const store = useSessionStreamStore.getState()
    store.optimisticAppendUser(SID, 'hi there', 'optimistic-x')
    expect(useSessionStreamStore.getState().byId[SID]?.turns).toHaveLength(1)
    store.removeOptimistic(SID, 'optimistic-x')
    expect(useSessionStreamStore.getState().byId[SID]?.turns).toHaveLength(0)
  })

  it('attaches recall.injected sources to the next finalised assistant turn', () => {
    const store = useSessionStreamStore.getState()
    store.applyEvent({
      type: 'recall.injected',
      sessionId: SID,
      sources: [
        { kind: 'wiki', ref: 'wiki/projects/24001/notes.md', title: 'Riverside notes' },
        { kind: 'history', ref: 'session/abc/turn/3', title: 'Earlier on Riverside' },
      ],
      ts: 1,
    } as never)
    // While the turn is still streaming, recall is buffered (not yet visible
    // on a finalised turn).
    expect(useSessionStreamStore.getState().byId[SID]?.turnMetadata).toEqual({})
    store.applyEvent({ type: 'message.assistant.started', sessionId: SID, turnId: 't1', ts: 2 } as never)
    store.applyEvent({ type: 'message.assistant.delta', sessionId: SID, turnId: 't1', delta: 'ok', ts: 3 } as never)
    store.applyEvent({
      type: 'message.assistant.completed',
      sessionId: SID,
      turnId: 't1',
      inputTokens: 1,
      outputTokens: 1,
      ts: 4,
    } as never)
    const after = useSessionStreamStore.getState().byId[SID]
    expect(after?.turnMetadata['t1']?.recallSources).toHaveLength(2)
    expect(after?.pendingRecall).toEqual([])
  })

  it('finalises tool chips alongside recall sources under one metadata entry', () => {
    const store = useSessionStreamStore.getState()
    store.applyEvent({ type: 'message.assistant.started', sessionId: SID, turnId: 't1', ts: 1 } as never)
    store.applyEvent({
      type: 'tool.called',
      sessionId: SID,
      turnId: 't1',
      toolCallId: 'tc1',
      tool: 'fs.read',
      args: {},
      ts: 2,
    } as never)
    store.applyEvent({
      type: 'tool.completed',
      sessionId: SID,
      turnId: 't1',
      toolCallId: 'tc1',
      tool: 'fs.read',
      ok: true,
      durationMs: 5,
      ts: 3,
    } as never)
    store.applyEvent({
      type: 'recall.injected',
      sessionId: SID,
      sources: [{ kind: 'wiki', ref: 'a', title: 'A' }],
      ts: 4,
    } as never)
    store.applyEvent({
      type: 'message.assistant.completed',
      sessionId: SID,
      turnId: 't1',
      inputTokens: 1,
      outputTokens: 1,
      ts: 5,
    } as never)
    const meta = useSessionStreamStore.getState().byId[SID]?.turnMetadata['t1']
    expect(meta?.toolChips?.[0]?.toolCallId).toBe('tc1')
    expect(meta?.recallSources).toHaveLength(1)
  })

  it('collapses context.compressing + context.compressed into a single meta row', () => {
    const store = useSessionStreamStore.getState()
    store.applyEvent({ type: 'context.compressing', sessionId: SID, tokensBefore: 9000, ts: 1 } as never)
    let meta = useSessionStreamStore.getState().byId[SID]?.metaRows
    expect(meta).toHaveLength(1)
    expect(meta?.[0]?.text).toMatch(/Compressing/)
    expect(meta?.[0]?.tag).toBe('compressing')

    store.applyEvent({
      type: 'context.compressed',
      sessionId: SID,
      tokensBefore: 9000,
      tokensAfter: 1500,
      turnsCompressed: 30,
      ts: 2,
    } as never)
    meta = useSessionStreamStore.getState().byId[SID]?.metaRows
    expect(meta).toHaveLength(1)
    expect(meta?.[0]?.text).toContain('Compressed 30 turns')
    expect(meta?.[0]?.tag).toBeUndefined()
  })

  it('collapses context.compressing + context.compression_failed into one error row', () => {
    const store = useSessionStreamStore.getState()
    store.applyEvent({ type: 'context.compressing', sessionId: SID, tokensBefore: 9000, ts: 1 } as never)
    store.applyEvent({
      type: 'context.compression_failed',
      sessionId: SID,
      reason: 'compressor offline',
      ts: 2,
    } as never)
    const meta = useSessionStreamStore.getState().byId[SID]?.metaRows
    expect(meta).toHaveLength(1)
    expect(meta?.[0]?.kind).toBe('error')
    expect(meta?.[0]?.text).toContain('compressor offline')
  })

  it('replaces an optimistic turn id when message.user.received fires', () => {
    const store = useSessionStreamStore.getState()
    store.optimisticAppendUser(SID, 'hi', 'optimistic-a')
    store.applyEvent({
      type: 'message.user.received',
      sessionId: SID,
      turnId: 'server-turn-1',
      ts: 1,
    } as never)
    const turns = useSessionStreamStore.getState().byId[SID]?.turns
    expect(turns?.[0]?.id).toBe('server-turn-1')
  })
})

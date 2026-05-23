import { describe, it, expect, vi } from 'vitest'
import { parseAgentEvent, AgentEventSchema } from '@/types/events'

describe('parseAgentEvent', () => {
  it('parses a known event', () => {
    const ev = parseAgentEvent({
      type: 'message.assistant.delta',
      sessionId: 's',
      turnId: 't',
      delta: 'hi',
    })
    expect(ev?.type).toBe('message.assistant.delta')
  })

  it('drops unknown event types with a warning', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(parseAgentEvent({ type: 'fake.event', sessionId: 's' })).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('accepts known event types loosely (server is schema authority)', () => {
    // Loose validation: known types pass through even with shape gaps. The
    // server enforces shape; the client trusts the type label and degrades
    // gracefully if a field is missing.
    expect(parseAgentEvent({ type: 'message.assistant.delta' })?.type).toBe('message.assistant.delta')
  })

  it('rejects non-object inputs', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(parseAgentEvent('not-an-object')).toBeNull()
    expect(parseAgentEvent(null)).toBeNull()
    spy.mockRestore()
  })
})

describe('AgentEventSchema', () => {
  it('discriminates on type', () => {
    const safe = AgentEventSchema.safeParse({
      type: 'tool.called',
      sessionId: 's',
      turnId: 't',
      toolCallId: 'tc',
      tool: 'foo',
      args: {},
      ts: 1,
    })
    expect(safe.success).toBe(true)
  })
})

export type AgentEvent =
  | { type: 'session.created'; sessionId: string; agentProfile: string; ts: number }
  | { type: 'message.user.received'; sessionId: string; turnId: string; ts: number }
  | { type: 'message.assistant.started'; sessionId: string; turnId: string; ts: number }
  | { type: 'message.assistant.delta'; sessionId: string; turnId: string; delta: string }
  | {
      type: 'message.assistant.completed'
      sessionId: string
      turnId: string
      inputTokens: number
      outputTokens: number
      ts: number
    }
  | {
      type: 'context.compressing'
      sessionId: string
      tokensBefore: number
      ts: number
    }
  | {
      type: 'context.compressed'
      sessionId: string
      tokensBefore: number
      tokensAfter: number
      turnsCompressed: number
      ts: number
    }
  | {
      type: 'context.compression_failed'
      sessionId: string
      reason: string
      ts: number
    }
  | {
      type: 'context.truncated'
      sessionId: string
      turnId: string
      bytesBefore: number
      bytesAfter: number
      ts: number
    }

export type EventType = AgentEvent['type']
export type EventByType<T extends EventType> = Extract<AgentEvent, { type: T }>

type AnyHandler = (e: AgentEvent) => void | Promise<void>

export class EventBus {
  private handlers = new Map<EventType, Set<AnyHandler>>()
  private wildcard = new Set<AnyHandler>()

  on<T extends EventType>(
    type: T,
    handler: (e: EventByType<T>) => void | Promise<void>,
  ): () => void {
    // Buckets already type-narrow by `type` — store the handler directly with
    // a single cast at insertion, no per-emit guard.
    const stored = handler as unknown as AnyHandler
    const set = this.handlers.get(type) ?? new Set<AnyHandler>()
    set.add(stored)
    this.handlers.set(type, set)
    return () => set.delete(stored)
  }

  onAny(handler: AnyHandler): () => void {
    this.wildcard.add(handler)
    return () => this.wildcard.delete(handler)
  }

  async emit(event: AgentEvent): Promise<void> {
    const typed = this.handlers.get(event.type)
    const calls: Array<void | Promise<void>> = []
    if (typed) for (const h of typed) calls.push(h(event))
    for (const h of this.wildcard) calls.push(h(event))
    // allSettled: observational contract — one bad observer does not abort the turn.
    await Promise.allSettled(calls)
  }
}

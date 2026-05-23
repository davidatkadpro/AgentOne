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
  | {
      type: 'tool.result_truncated'
      sessionId: string
      /** LLM-side tool call identifier — the same id read_turn accepts. */
      toolCallId: string
      tokensBefore: number
      tokensAfter: number
      ts: number
    }
  | {
      type: 'tool.called'
      sessionId: string
      turnId: string
      toolCallId: string
      tool: string
      args: unknown
      ts: number
    }
  | {
      type: 'tool.completed'
      sessionId: string
      turnId: string
      toolCallId: string
      tool: string
      ok: boolean
      durationMs: number
      ts: number
    }
  | {
      type: 'tool.failed'
      sessionId: string
      turnId: string
      toolCallId: string
      tool: string
      code: string
      message: string
      ts: number
    }
  | {
      type: 'tool.hook_denied'
      sessionId: string
      tool: string
      hook: string
      reason: string
      ts: number
    }
  | {
      type: 'tool.hook_mocked'
      sessionId: string
      tool: string
      hook: string
      ts: number
    }
  | {
      type: 'skill.loading'
      sessionId: string
      name: string
      ts: number
    }
  | {
      type: 'skill.loaded'
      sessionId: string
      name: string
      toolsRegistered: string[]
      ts: number
    }
  | {
      type: 'skill.load_failed'
      sessionId: string
      name: string
      reason: string
      ts: number
    }
  | {
      type: 'embedding.indexed'
      sessionId: null
      turnsIndexed: number
      ts: number
    }
  | {
      type: 'embedding.failed'
      sessionId: null
      reason: string
      /** How many consecutive failures have piled up. 1 on the first drop;
       *  re-emitted every escalationStep failures (default 10) so a
       *  permanently-broken endpoint stays observable. */
      consecutiveFailures: number
      ts: number
    }
  | {
      type: 'expert.consulted'
      sessionId: string
      expert: string
      model: string
      inputTokens: number
      outputTokens: number
      costUsd: number
      sessionSpendUsd: number
      /** Wall-clock duration of the provider.chat() call, in milliseconds.
       *  Surfaced for the UI to render alongside cost/tokens and to feed
       *  into the future "expert response latency" PRD metric. */
      latencyMs: number
      ts: number
    }
  | {
      type: 'expert.budget_exceeded'
      sessionId: string
      expert: string
      costUsd: number
      perCallBudgetUsd: number
      ts: number
    }
  | {
      type: 'recall.injected'
      sessionId: string
      sources: Array<{ kind: 'wiki' | 'history'; ref: string; title: string }>
      ts: number
    }
  | {
      type: 'session.titled'
      sessionId: string
      title: string
      ts: number
    }
  | {
      type: 'session.auto_distilled'
      sessionId: string
      notesCount: number
      draftPath: string
      ts: number
    }
  | {
      type: 'session.auto_distill_skipped'
      sessionId: string
      reason: 'no_turns' | 'too_short' | 'no_notes' | 'parse_failure' | 'already_distilled' | 'provider_error'
      ts: number
    }
  | {
      type: 'drafts.pruned'
      /** Relative paths under wiki/ (e.g. "drafts/distilled-xxx.md"). */
      paths: string[]
      /** The age threshold that triggered the prune. */
      olderThanDays: number
      ts: number
    }
  | {
      type: 'turn.cancel_requested'
      sessionId: string
      ts: number
    }
  | {
      type: 'turn.cancelled'
      sessionId: string
      /** "soft" = cancellation observed at a loop boundary; "hard" = the
       *  in-flight provider stream or tool call had to be torn down. */
      kind: 'soft' | 'hard'
      ts: number
    }
  | {
      type: 'session.awaiting_input'
      sessionId: string
      /** Id of the notification surfaced when the agent requested input. */
      notificationId: number
      /** The question the agent posed (the `question` arg to request_user_input). */
      question: string
      ts: number
    }
  // -- contributed by modules/projects --
  | { type: 'project.created'; projectId: string; number: string; ts: number }
  | { type: 'project.updated'; projectId: string; ts: number }
  | { type: 'project.completed'; projectId: string; ts: number }
  | { type: 'phase.created'; projectId: string; phaseId: string; ts: number }
  | { type: 'phase.completed'; projectId: string; phaseId: string; ts: number }
  | { type: 'task.created'; projectId: string; phaseId: string; taskId: string; ts: number }
  | { type: 'task.updated'; projectId: string; taskId: string; ts: number }
  | { type: 'task.completed'; projectId: string; taskId: string; ts: number }
  | { type: 'task.blocked'; projectId: string; taskId: string; reason: string | null; ts: number }

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

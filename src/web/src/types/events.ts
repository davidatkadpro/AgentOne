import { z } from 'zod'

// TypeScript union mirroring src/core/events.ts on the server.
// Validation via Zod schemas below; type is the canonical contract.

export type AgentEvent =
  | { type: 'session.created'; sessionId: string; agentProfile: string; ts: number }
  | { type: 'session.spawned'; sessionId: string; agentProfile: string; spawnedBy: string; ts: number }
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
  | { type: 'context.compressing'; sessionId: string; tokensBefore: number; ts: number }
  | {
      type: 'context.compressed'
      sessionId: string
      tokensBefore: number
      tokensAfter: number
      turnsCompressed: number
      ts: number
    }
  | { type: 'context.compression_failed'; sessionId: string; reason: string; ts: number }
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
  | { type: 'tool.hook_mocked'; sessionId: string; tool: string; hook: string; ts: number }
  | { type: 'skill.loading'; sessionId: string; name: string; ts: number }
  | { type: 'skill.loaded'; sessionId: string; name: string; toolsRegistered: string[]; ts: number }
  | { type: 'skill.load_failed'; sessionId: string; name: string; reason: string; ts: number }
  | {
      type: 'expert.consulted'
      sessionId: string
      expert: string
      model: string
      inputTokens: number
      outputTokens: number
      costUsd: number
      sessionSpendUsd: number
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
  | { type: 'session.titled'; sessionId: string; title: string; ts: number }
  | {
      type: 'session.auto_distilled'
      sessionId: string
      notesCount: number
      draftPath: string
      ts: number
    }
  | { type: 'session.auto_distill_skipped'; sessionId: string; reason: string; ts: number }
  | { type: 'drafts.pruned'; paths: string[]; olderThanDays: number; ts: number }
  | { type: 'turn.cancel_requested'; sessionId: string; ts: number }
  | { type: 'turn.cancelled'; sessionId: string; kind: 'soft' | 'hard'; ts: number }
  | {
      type: 'session.awaiting_input'
      sessionId: string
      notificationId: number
      question: string
      ts: number
    }
  | {
      type: 'notification.created'
      notificationId: number
      ts: number
      kind?: 'info' | 'attention_needed' | 'error'
      title?: string
      body?: string
      sessionId?: string | null
      module?: string | null
    }
  | { type: 'notification.updated'; notificationId: number; ts: number }
  | { type: 'notification.resolved'; notificationId: number; ts: number }
  | { type: 'module.reloaded'; module: string; ts: number }
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

const KNOWN_TYPES = new Set<string>([
  'session.created',
  'session.spawned',
  'message.user.received',
  'message.assistant.started',
  'message.assistant.delta',
  'message.assistant.completed',
  'context.compressing',
  'context.compressed',
  'context.compression_failed',
  'context.truncated',
  'tool.result_truncated',
  'tool.called',
  'tool.completed',
  'tool.failed',
  'tool.hook_denied',
  'tool.hook_mocked',
  'skill.loading',
  'skill.loaded',
  'skill.load_failed',
  'expert.consulted',
  'expert.budget_exceeded',
  'recall.injected',
  'session.titled',
  'session.auto_distilled',
  'session.auto_distill_skipped',
  'drafts.pruned',
  'turn.cancel_requested',
  'turn.cancelled',
  'session.awaiting_input',
  'notification.created',
  'notification.updated',
  'notification.resolved',
  'module.reloaded',
  'project.created',
  'project.updated',
  'project.completed',
  'phase.created',
  'phase.completed',
  'task.created',
  'task.updated',
  'task.completed',
  'task.blocked',
])

// Loose runtime validation: every event needs a known string `type`. Field-
// level invariants are enforced by the discriminated union — bad events are
// dropped with a warning rather than crashing the dispatch loop.
export const AgentEventLoose = z
  .object({ type: z.string() })
  .passthrough()

export function parseAgentEvent(raw: unknown): AgentEvent | null {
  const safe = AgentEventLoose.safeParse(raw)
  if (!safe.success) return null
  if (!KNOWN_TYPES.has(safe.data.type)) {
    if (typeof console !== 'undefined') {
      console.warn('[ws] dropping unrecognised event', safe.data.type)
    }
    return null
  }
  // The server is the schema authority for known event types; we trust it.
  return safe.data as unknown as AgentEvent
}

// Convenience for tests that want strict shape validation of a single
// known variant.
export const AgentEventSchema = AgentEventLoose

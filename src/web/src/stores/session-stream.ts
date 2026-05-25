import { create } from 'zustand'
import type { Turn, ToolChipState, ToolCallRecord } from '@/types/domain'
import type { AgentEvent } from '@/types/events'
import type { SessionDetailResponse } from '@/types/api'

export interface MetaRow {
  id: string
  ts: number
  text: string
  kind: 'info' | 'warn' | 'error'
  /** Optional tag so a follow-up event can find + replace this row
   *  (e.g. context.compressed replaces context.compressing). */
  tag?: string
}

export interface RecallSource {
  kind: 'wiki' | 'history'
  ref: string
  title: string
}

/**
 * Per-turn metadata attributed to a finalised assistant turn. New per-turn
 * signals (context-compression info, hook chain, etc.) should extend this
 * shape rather than adding a parallel `xByTurn` dictionary on the stream —
 * see [[architecture-deepening]] notes on `turnMetadata` consolidation.
 */
export interface TurnMetadata {
  toolChips?: ToolChipState[]
  recallSources?: RecallSource[]
}

export interface ActiveAssistant {
  turnId: string
  text: string
  toolChips: Record<string, ToolChipState>
}

export interface SessionStream {
  sessionId: string
  activeAssistant: ActiveAssistant | null
  turns: Turn[]
  /** Per-turn metadata for finalised assistant turns, keyed by turnId.
   *  Read by `MessageItem` to render tool chips and the recall info pill. */
  turnMetadata: Record<string, TurnMetadata>
  cancelRequested: boolean
  profileMismatch: { requiredProfile: string; message: string } | null
  awaitingInput: { notificationId: number; question: string } | null
  metaRows: MetaRow[]
  /** Sources from `recall.injected` events that arrived since the last
   *  assistant turn ended. Attributed to the next assistant turn on
   *  completion or cancellation. */
  pendingRecall: RecallSource[]
}

interface SessionStreamState {
  byId: Record<string, SessionStream>
  ensure(sessionId: string): void
  drop(sessionId: string): void
  hydrateFromDetail(sessionId: string, detail: SessionDetailResponse): void
  applyEvent(event: AgentEvent): void
  setProfileMismatch(sessionId: string, info: SessionStream['profileMismatch']): void
  clearProfileMismatch(sessionId: string): void
  /** Optimistic insertion for useSendMessage. */
  optimisticAppendUser(sessionId: string, text: string, placeholderId: string): void
  removeOptimistic(sessionId: string, placeholderId: string): void
}

function emptyStream(sessionId: string): SessionStream {
  return {
    sessionId,
    activeAssistant: null,
    turns: [],
    turnMetadata: {},
    cancelRequested: false,
    profileMismatch: null,
    awaitingInput: null,
    metaRows: [],
    pendingRecall: [],
  }
}

/**
 * Finalise the active assistant turn's metadata. Attributes the active
 * assistant's tool chips and any buffered recall sources to `turnId`,
 * then clears `pendingRecall`. Called by both `message.assistant.completed`
 * and `turn.cancelled` so the two paths can't drift.
 */
function finalizeTurnMetadata(
  stream: SessionStream,
  turnId: string,
  chips: ToolChipState[],
): void {
  const meta: TurnMetadata = {}
  if (chips.length > 0) meta.toolChips = chips
  if (stream.pendingRecall.length > 0) meta.recallSources = stream.pendingRecall
  if (Object.keys(meta).length > 0) {
    stream.turnMetadata = { ...stream.turnMetadata, [turnId]: meta }
  }
  if (stream.pendingRecall.length > 0) stream.pendingRecall = []
}

function pushMeta(
  stream: SessionStream,
  text: string,
  kind: MetaRow['kind'],
  ts: number,
  opts?: { tag?: string },
): void {
  const row: MetaRow = {
    id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
    ts,
    text,
    kind,
  }
  if (opts?.tag) row.tag = opts.tag
  stream.metaRows.push(row)
  if (stream.metaRows.length > 50) stream.metaRows.shift()
}

/**
 * Replace the most recent meta row carrying `tag` with the new text/kind.
 * If no tagged row exists, the new row is appended like a normal push.
 * Used for "in-flight indicator → final result" transitions.
 */
function replaceTaggedMeta(
  stream: SessionStream,
  tag: string,
  text: string,
  kind: MetaRow['kind'],
  ts: number,
): void {
  for (let i = stream.metaRows.length - 1; i >= 0; i--) {
    if (stream.metaRows[i]?.tag === tag) {
      stream.metaRows[i] = {
        ...stream.metaRows[i]!,
        text,
        kind,
        ts,
        tag: undefined,
      }
      return
    }
  }
  pushMeta(stream, text, kind, ts)
}

function safeParseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function toolChipFromRecord(rec: ToolCallRecord): ToolChipState {
  const out: ToolChipState = {
    toolCallId: rec.toolCallId,
    tool: rec.tool,
    status: rec.ok === undefined ? 'pending' : rec.ok ? 'done' : 'failed',
  }
  if (rec.durationMs !== undefined) out.durationMs = rec.durationMs
  const args = safeParseJson(rec.argsJson)
  if (args !== undefined) out.args = args
  const result = safeParseJson(rec.resultJson)
  if (result !== undefined) out.result = result
  return out
}

export const useSessionStreamStore = create<SessionStreamState>((set) => ({
  byId: {},

  ensure(sessionId) {
    set((s) => {
      if (s.byId[sessionId]) return s
      return { byId: { ...s.byId, [sessionId]: emptyStream(sessionId) } }
    })
  },

  drop(sessionId) {
    set((s) => {
      const next = { ...s.byId }
      delete next[sessionId]
      return { byId: next }
    })
  },

  hydrateFromDetail(sessionId, detail) {
    set((s) => {
      const fresh = emptyStream(sessionId)
      fresh.turns = detail.turns
      for (const [turnId, calls] of Object.entries(detail.toolCalls)) {
        if (calls.length > 0) {
          fresh.turnMetadata[turnId] = { toolChips: calls.map(toolChipFromRecord) }
        }
      }
      return { byId: { ...s.byId, [sessionId]: fresh } }
    })
  },

  applyEvent(event) {
    set((s) => {
      if (!('sessionId' in event) || typeof event.sessionId !== 'string') return s
      const sid = event.sessionId
      const existing = s.byId[sid]
      if (!existing) return s
      const stream: SessionStream = {
        ...existing,
        turns: existing.turns,
        turnMetadata: existing.turnMetadata,
        metaRows: [...existing.metaRows],
        pendingRecall: [...existing.pendingRecall],
      }

      switch (event.type) {
        case 'message.user.received': {
          // The placeholder optimistic row, if present, is identified by
          // an id starting with `optimistic-`. Replace it with the server
          // turn id (we don't have content here — leave content as-is; a
          // detail refetch will fix it if needed).
          const placeholder = stream.turns.find((t) => t.id.startsWith('optimistic-') && t.role === 'user')
          if (placeholder) {
            stream.turns = stream.turns.map((t) =>
              t === placeholder ? { ...t, id: event.turnId } : t,
            )
          }
          break
        }
        case 'message.assistant.started':
          stream.activeAssistant = { turnId: event.turnId, text: '', toolChips: {} }
          break
        case 'message.assistant.delta': {
          if (!stream.activeAssistant) {
            stream.activeAssistant = { turnId: event.turnId, text: '', toolChips: {} }
          }
          stream.activeAssistant = {
            ...stream.activeAssistant,
            text: stream.activeAssistant.text + event.delta,
          }
          break
        }
        case 'message.assistant.completed': {
          const a = stream.activeAssistant
          if (a) {
            const newTurn: Turn = {
              id: a.turnId,
              sessionId: sid,
              role: 'assistant',
              content: a.text,
              tokenCount: 0,
              createdAt: event.ts,
            }
            stream.turns = [...stream.turns, newTurn]
            finalizeTurnMetadata(stream, a.turnId, Object.values(a.toolChips))
            stream.activeAssistant = null
          }
          break
        }
        case 'tool.called': {
          const chip: ToolChipState = {
            toolCallId: event.toolCallId,
            tool: event.tool,
            status: 'pending',
            args: event.args,
          }
          if (stream.activeAssistant) {
            stream.activeAssistant = {
              ...stream.activeAssistant,
              toolChips: { ...stream.activeAssistant.toolChips, [event.toolCallId]: chip },
            }
          }
          break
        }
        case 'tool.completed': {
          if (stream.activeAssistant) {
            const existing = stream.activeAssistant.toolChips[event.toolCallId]
            if (existing) {
              stream.activeAssistant = {
                ...stream.activeAssistant,
                toolChips: {
                  ...stream.activeAssistant.toolChips,
                  [event.toolCallId]: { ...existing, status: 'done', durationMs: event.durationMs },
                },
              }
            }
          }
          break
        }
        case 'tool.failed': {
          if (stream.activeAssistant) {
            const existing = stream.activeAssistant.toolChips[event.toolCallId]
            if (existing) {
              stream.activeAssistant = {
                ...stream.activeAssistant,
                toolChips: {
                  ...stream.activeAssistant.toolChips,
                  [event.toolCallId]: {
                    ...existing,
                    status: 'failed',
                    failCode: event.code,
                    failMessage: event.message,
                  },
                },
              }
            }
          }
          pushMeta(stream, `${event.tool} failed: ${event.code} — ${event.message}`, 'error', event.ts)
          break
        }
        case 'tool.result_truncated': {
          if (stream.activeAssistant) {
            const existing = stream.activeAssistant.toolChips[event.toolCallId]
            if (existing) {
              stream.activeAssistant = {
                ...stream.activeAssistant,
                toolChips: {
                  ...stream.activeAssistant.toolChips,
                  [event.toolCallId]: { ...existing, truncated: true },
                },
              }
            }
          }
          pushMeta(
            stream,
            `Tool result truncated (${event.tokensBefore} → ${event.tokensAfter} tokens)`,
            'warn',
            event.ts,
          )
          break
        }
        case 'turn.cancel_requested':
          stream.cancelRequested = true
          break
        case 'turn.cancelled': {
          stream.cancelRequested = false
          if (stream.activeAssistant) {
            const a = stream.activeAssistant
            stream.turns = [
              ...stream.turns,
              {
                id: a.turnId,
                sessionId: sid,
                role: 'assistant',
                content: a.text || '(cancelled)',
                tokenCount: 0,
                createdAt: event.ts,
              },
            ]
            finalizeTurnMetadata(stream, a.turnId, Object.values(a.toolChips))
            stream.activeAssistant = null
          }
          pushMeta(stream, `Cancelled (${event.kind})`, 'warn', event.ts)
          break
        }
        case 'session.awaiting_input':
          stream.awaitingInput = { notificationId: event.notificationId, question: event.question }
          break
        case 'recall.injected':
          // Buffer until the next assistant turn completes; finalizeTurnMetadata
          // attributes these to the turn alongside its tool chips.
          stream.pendingRecall = [...stream.pendingRecall, ...event.sources]
          break
        case 'context.compressing':
          // Marked transient via a `compressing` tag so the matching
          // `context.compressed` (or `_failed`) event can replace it
          // instead of leaving two rows in the chat — the "Compressing…"
          // spinner is only useful while the call is in flight.
          pushMeta(stream, 'Compressing context…', 'info', event.ts, { tag: 'compressing' })
          break
        case 'context.compressed':
          replaceTaggedMeta(
            stream,
            'compressing',
            `Compressed ${event.turnsCompressed} turns (${event.tokensBefore} → ${event.tokensAfter} tokens)`,
            'info',
            event.ts,
          )
          break
        case 'context.compression_failed':
          replaceTaggedMeta(
            stream,
            'compressing',
            `Compression failed: ${event.reason}`,
            'error',
            event.ts,
          )
          break
        case 'context.truncated':
          pushMeta(stream, `Context truncated (${event.bytesBefore} → ${event.bytesAfter} bytes)`, 'warn', event.ts)
          break
        case 'skill.loading':
          pushMeta(stream, `Loading skill: ${event.name}…`, 'info', event.ts)
          break
        case 'skill.loaded':
          pushMeta(
            stream,
            `Loaded skill ${event.name}` +
              (event.toolsRegistered.length
                ? ` (+${event.toolsRegistered.length} tool${event.toolsRegistered.length === 1 ? '' : 's'})`
                : ''),
            'info',
            event.ts,
          )
          break
        case 'skill.load_failed':
          pushMeta(stream, `Skill ${event.name} failed: ${event.reason}`, 'error', event.ts)
          break
        case 'expert.consulted':
          pushMeta(
            stream,
            `Consulted ${event.expert} — $${event.costUsd.toFixed(4)} (${event.latencyMs}ms)`,
            'info',
            event.ts,
          )
          break
        case 'expert.budget_exceeded':
          pushMeta(
            stream,
            `Expert call to ${event.expert} cost $${event.costUsd.toFixed(4)} (over budget)`,
            'error',
            event.ts,
          )
          break
        case 'tool.hook_denied':
          pushMeta(stream, `Tool ${event.tool} denied by hook "${event.hook}": ${event.reason}`, 'error', event.ts)
          break
        case 'tool.hook_mocked':
          pushMeta(stream, `Tool ${event.tool} mocked by hook "${event.hook}"`, 'info', event.ts)
          break
        case 'session.auto_distilled':
          pushMeta(
            stream,
            `Auto-distilled ${event.notesCount} note${event.notesCount === 1 ? '' : 's'} → ${event.draftPath}`,
            'info',
            event.ts,
          )
          break
        default:
          // Many events (notifications, embedding, module) are handled by
          //  other stores or are pure cache invalidation triggers.
          return s
      }

      return { byId: { ...s.byId, [sid]: stream } }
    })
  },

  setProfileMismatch(sessionId, info) {
    set((s) => {
      const stream = s.byId[sessionId]
      if (!stream) return s
      return { byId: { ...s.byId, [sessionId]: { ...stream, profileMismatch: info } } }
    })
  },

  clearProfileMismatch(sessionId) {
    set((s) => {
      const stream = s.byId[sessionId]
      if (!stream) return s
      return { byId: { ...s.byId, [sessionId]: { ...stream, profileMismatch: null } } }
    })
  },

  optimisticAppendUser(sessionId, text, placeholderId) {
    set((s) => {
      const stream = s.byId[sessionId]
      if (!stream) return s
      const turn: Turn = {
        id: placeholderId,
        sessionId,
        role: 'user',
        content: text,
        tokenCount: 0,
        createdAt: Date.now(),
      }
      return {
        byId: { ...s.byId, [sessionId]: { ...stream, turns: [...stream.turns, turn] } },
      }
    })
  },

  removeOptimistic(sessionId, placeholderId) {
    set((s) => {
      const stream = s.byId[sessionId]
      if (!stream) return s
      return {
        byId: {
          ...s.byId,
          [sessionId]: { ...stream, turns: stream.turns.filter((t) => t.id !== placeholderId) },
        },
      }
    })
  },
}))

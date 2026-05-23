import { create } from 'zustand'
import type { Turn, ToolChipState, ToolCallRecord } from '@/types/domain'
import type { AgentEvent } from '@/types/events'
import type { SessionDetailResponse } from '@/types/api'

export interface MetaRow {
  id: string
  ts: number
  text: string
  kind: 'info' | 'warn' | 'error'
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
  toolCalls: Record<string, ToolChipState[]>
  cancelRequested: boolean
  profileMismatch: { requiredProfile: string; message: string } | null
  awaitingInput: { notificationId: number; question: string } | null
  metaRows: MetaRow[]
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
    toolCalls: {},
    cancelRequested: false,
    profileMismatch: null,
    awaitingInput: null,
    metaRows: [],
  }
}

function pushMeta(stream: SessionStream, text: string, kind: MetaRow['kind'], ts: number): void {
  stream.metaRows.push({ id: `${ts}-${Math.random().toString(36).slice(2, 8)}`, ts, text, kind })
  if (stream.metaRows.length > 50) stream.metaRows.shift()
}

function toolChipFromRecord(rec: ToolCallRecord): ToolChipState {
  return {
    toolCallId: rec.toolCallId,
    tool: rec.tool,
    status: rec.ok === undefined ? 'pending' : rec.ok ? 'done' : 'failed',
    durationMs: rec.durationMs,
  }
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
        fresh.toolCalls[turnId] = calls.map(toolChipFromRecord)
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
        toolCalls: { ...existing.toolCalls },
        metaRows: [...existing.metaRows],
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
            const chips = Object.values(a.toolChips)
            if (chips.length > 0) stream.toolCalls[a.turnId] = chips
            stream.activeAssistant = null
          }
          break
        }
        case 'tool.called': {
          const chip: ToolChipState = {
            toolCallId: event.toolCallId,
            tool: event.tool,
            status: 'pending',
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
            const chips = Object.values(a.toolChips)
            if (chips.length > 0) stream.toolCalls[a.turnId] = chips
            stream.activeAssistant = null
          }
          pushMeta(stream, `Cancelled (${event.kind})`, 'warn', event.ts)
          break
        }
        case 'session.awaiting_input':
          stream.awaitingInput = { notificationId: event.notificationId, question: event.question }
          break
        case 'recall.injected':
          pushMeta(
            stream,
            `Passive recall: ${event.sources.length} source${event.sources.length === 1 ? '' : 's'}`,
            'info',
            event.ts,
          )
          break
        case 'context.compressing':
          pushMeta(stream, 'Compressing context…', 'info', event.ts)
          break
        case 'context.compressed':
          pushMeta(
            stream,
            `Compressed ${event.turnsCompressed} turns (${event.tokensBefore} → ${event.tokensAfter} tokens)`,
            'info',
            event.ts,
          )
          break
        case 'context.compression_failed':
          pushMeta(stream, `Compression failed: ${event.reason}`, 'error', event.ts)
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

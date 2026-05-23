import { create } from 'zustand'

type WsStatus = 'connecting' | 'open' | 'closed' | 'reconnecting'

interface WsState {
  status: WsStatus
  reconnectAttempts: number
  /** Reference-counted subscription map. */
  refCounts: Record<string, number>
  setStatus(status: WsStatus): void
  setAttempts(n: number): void
  incRef(sessionId: string): number
  decRef(sessionId: string): number
}

export const useWsStore = create<WsState>((set, get) => ({
  status: 'connecting',
  reconnectAttempts: 0,
  refCounts: {},
  setStatus(status) {
    set({ status })
  },
  setAttempts(n) {
    set({ reconnectAttempts: n })
  },
  incRef(sessionId) {
    const refs = { ...get().refCounts }
    refs[sessionId] = (refs[sessionId] ?? 0) + 1
    set({ refCounts: refs })
    return refs[sessionId]
  },
  decRef(sessionId) {
    const refs = { ...get().refCounts }
    const next = (refs[sessionId] ?? 0) - 1
    if (next <= 0) delete refs[sessionId]
    else refs[sessionId] = next
    set({ refCounts: refs })
    return next > 0 ? next : 0
  },
}))

export function subscribedSessions(): string[] {
  return Object.keys(useWsStore.getState().refCounts)
}

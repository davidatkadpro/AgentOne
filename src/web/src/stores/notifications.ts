import { create } from 'zustand'
import type { AgentEvent } from '@/types/events'

export interface ToastEntry {
  id: string
  notificationId: number
  title: string
  body: string | null
  kind: 'info' | 'attention_needed' | 'error'
  receivedAt: number
}

interface NotificationsState {
  unresolvedAttentionCount: number
  toastQueue: ToastEntry[]
  reconcileCount(count: number): void
  applyEvent(event: AgentEvent): void
  dismissToast(id: string): void
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  unresolvedAttentionCount: 0,
  toastQueue: [],

  reconcileCount(count) {
    set({ unresolvedAttentionCount: Math.max(0, count) })
  },

  applyEvent(event) {
    if (event.type === 'notification.created') {
      const e = event as AgentEvent & { kind?: string; title?: string; body?: string }
      const kind = (e.kind as ToastEntry['kind']) ?? 'info'
      set((s) => {
        const isAttention = kind === 'attention_needed'
        return {
          unresolvedAttentionCount: isAttention
            ? s.unresolvedAttentionCount + 1
            : s.unresolvedAttentionCount,
          toastQueue: [
            ...s.toastQueue,
            {
              id: `${event.ts}-${Math.random().toString(36).slice(2, 8)}`,
              notificationId: (event as { notificationId: number }).notificationId,
              title: e.title ?? 'Notification',
              body: e.body ?? null,
              kind,
              receivedAt: event.ts,
            },
          ],
        }
      })
    } else if (event.type === 'notification.resolved') {
      set((s) => ({ unresolvedAttentionCount: Math.max(0, s.unresolvedAttentionCount - 1) }))
    } else if (event.type === 'notification.updated') {
      // We don't know whether the status moved off attention_needed without
      // refetching; rely on the count reconciliation via TanStack Query.
    }
  },

  dismissToast(id) {
    set((s) => ({ toastQueue: s.toastQueue.filter((t) => t.id !== id) }))
  },
}))

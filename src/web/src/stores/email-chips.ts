import { create } from 'zustand'
import type { AgentEvent } from '@/types/events'
import type { EmailActionChip } from '@/types/domain'

interface EmailChipsState {
  byEmailId: Record<string, EmailActionChip>
  applyEvent(event: AgentEvent): void
  clear(emailId: string): void
}

export const useEmailChipsStore = create<EmailChipsState>((set, get) => ({
  byEmailId: {},
  applyEvent(event) {
    if (event.type === 'email.action_started') {
      const next = { ...get().byEmailId }
      next[event.emailId] = {
        emailId: event.emailId,
        action: event.action,
        sessionId: event.sessionId,
        status: 'running',
        startedAt: event.ts,
      }
      set({ byEmailId: next })
      return
    }
    if (event.type === 'email.action_completed') {
      const existing = get().byEmailId[event.emailId]
      if (!existing || existing.sessionId !== event.sessionId) return
      const next = { ...get().byEmailId }
      next[event.emailId] = {
        ...existing,
        status: event.ok ? 'completed' : 'failed',
        endedAt: event.ts,
      }
      set({ byEmailId: next })
      return
    }
    if (event.type === 'email.filed') {
      // Enrich the running chip with the filed project info so the row chip
      // can switch to `✓ filed to <projectId-short>` after completion.
      const existing = get().byEmailId[event.emailId]
      if (!existing) return
      const next = { ...get().byEmailId }
      next[event.emailId] = {
        ...existing,
        result: { ...(existing.result ?? {}), projectId: event.projectId },
      }
      set({ byEmailId: next })
    }
  },
  clear(emailId) {
    const next = { ...get().byEmailId }
    delete next[emailId]
    set({ byEmailId: next })
  },
}))

export function useEmailChip(emailId: string | null | undefined): EmailActionChip | null {
  return useEmailChipsStore((s) => (emailId ? s.byEmailId[emailId] ?? null : null))
}

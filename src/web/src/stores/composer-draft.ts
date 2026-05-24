import { create } from 'zustand'

/** Per-session composer draft store. Used by the starter card and any other
 *  surface that wants to prefill the Composer textarea without going through
 *  refs or prop drilling. */
interface ComposerDraftState {
  drafts: Record<string, string>
  set(sessionId: string, text: string): void
  consume(sessionId: string): string | undefined
}

export const useComposerDraftStore = create<ComposerDraftState>((set, get) => ({
  drafts: {},
  set(sessionId, text) {
    set((s) => ({ drafts: { ...s.drafts, [sessionId]: text } }))
  },
  consume(sessionId) {
    const value = get().drafts[sessionId]
    if (value === undefined) return undefined
    set((s) => {
      const next = { ...s.drafts }
      delete next[sessionId]
      return { drafts: next }
    })
    return value
  },
}))

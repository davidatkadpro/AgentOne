import { z } from 'zod'
import { defineCommand } from './types.js'

const args = z.object({
  confirm: z
    .boolean()
    .default(false)
    .describe('Required true to actually delete; the UI sets this after a confirm dialog.'),
})

export const clearCommand = defineCommand({
  name: 'clear',
  description:
    'Delete every turn in the current session. The session itself remains so prior /search_history results still resolve.',
  usage: '/clear (confirm dialog required)',
  args,
  requiresSession: true,
  handler: async (parsed, ctx) => {
    if (!parsed.confirm) {
      return {
        kind: 'error',
        message: '/clear is destructive — confirm in the UI to proceed',
        recoverable: true,
      }
    }
    const sessionId = ctx.sessionId as string
    const deleted = ctx.store.clearTurns(sessionId)
    // The next message in this session will rebuild context from the now-empty
    // turn list. The orchestrator caches a SessionState per id; resetting it
    // discards any held tool registry / loaded skills so /clear is a true reset.
    ctx.orchestrator.resetSession(sessionId)
    ctx.contextManager.reset(sessionId)
    return { kind: 'session_cleared', sessionId, turnsDeleted: deleted }
  },
})

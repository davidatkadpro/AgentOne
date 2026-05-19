import { z } from 'zod'
import { defineCommand } from './types.js'

const args = z.object({})

export const compactCommand = defineCommand({
  name: 'compact',
  description:
    'Force a context compression now. Older turns get summarised; the most recent ones stay verbatim.',
  usage: '/compact',
  args,
  requiresSession: true,
  handler: async (_parsed, ctx) => {
    const sessionId = ctx.sessionId as string
    const result = await ctx.orchestrator.compactSession(sessionId)
    if (!result.changed) {
      return {
        kind: 'text',
        content: 'Nothing to compact — the recency window already holds the whole conversation.',
      }
    }
    return {
      kind: 'context_compacted',
      sessionId,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      changed: true,
    }
  },
})

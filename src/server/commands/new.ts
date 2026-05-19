import { z } from 'zod'
import { defineCommand } from './types.js'

const args = z.object({
  /** Optional agent profile id; falls back to the configured default. */
  profile: z.string().optional(),
  title: z.string().optional(),
})

export const newCommand = defineCommand({
  name: 'new',
  description: 'Create a fresh session and switch to it.',
  usage: '/new [profile] [title]',
  args,
  requiresSession: false,
  handler: async (parsed, ctx) => {
    const session = ctx.store.createSession({
      agentProfile: parsed.profile ?? ctx.config.agentProfile,
      title: parsed.title ?? null,
    })
    return { kind: 'session_switch', session, reason: 'new' }
  },
})

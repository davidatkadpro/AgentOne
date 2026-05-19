import { z } from 'zod'
import { defineCommand, type SessionSummary } from './types.js'

const args = z.object({
  limit: z.coerce.number().int().positive().max(200).default(20),
})

export const sessionsCommand = defineCommand({
  name: 'sessions',
  description: 'List recent sessions. Click one to resume.',
  usage: '/sessions [limit=20]',
  args,
  requiresSession: false,
  handler: async (parsed, ctx) => {
    const rows = ctx.store.listSessions(parsed.limit)
    const counts = ctx.store.countTurnsBySession(rows.map((s) => s.id))
    const summaries: SessionSummary[] = rows.map((s) => ({
      id: s.id,
      title: s.title,
      agentProfile: s.agentProfile,
      createdAt: s.createdAt,
      turnCount: counts.get(s.id) ?? 0,
    }))
    return { kind: 'session_list', sessions: summaries }
  },
})

import { z } from 'zod'
import { defineCommand } from './types.js'
import { turnsToMessages } from '../../storage/sqlite.js'
import {
  distill,
  renderDistilledMarkdown,
  type DistilledNote,
} from '../../skills/distiller.js'

const args = z.object({})

export const distillCommand = defineCommand({
  name: 'distill',
  description:
    'Extract durable facts from this session and write them to a draft wiki page for review.',
  usage: '/distill',
  args,
  requiresSession: true,
  handler: async (_parsed, ctx) => {
    const sessionId = ctx.sessionId as string
    const session = ctx.store.getSession(sessionId)
    if (!session) {
      return { kind: 'error', message: `Session not found: ${sessionId}`, recoverable: false }
    }

    const turns = ctx.store.listTurns(sessionId)
    if (turns.length === 0) {
      return {
        kind: 'text',
        content: 'Nothing to distill — this session has no turns yet.',
      }
    }

    const toolCalls = ctx.store.listToolCallsBySession(sessionId)
    const transcript = turnsToMessages(turns, toolCalls)

    let result
    try {
      result = await distill(transcript, ctx.compressorProvider, ctx.compressorModel)
    } catch (err) {
      return {
        kind: 'error',
        message: `Distiller call failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
      }
    }

    if (result.notes.length === 0) {
      return {
        kind: 'text',
        content: result.reparseUsed
          ? 'No durable facts extracted (the model returned non-JSON content we could not parse). Run /distill again or inspect the model output manually.'
          : 'No durable facts extracted from this session. Nothing was written.',
      }
    }

    // Path is stable per (session, day) so re-running on the same day
    // updates the same draft rather than littering the drafts dir. The
    // wiki engine's persist path upserts on path collision.
    const dateSlug = new Date().toISOString().slice(0, 10)
    const draftPath = `drafts/distilled-${sessionId}-${dateSlug}`
    const markdown = renderDistilledMarkdown({
      sessionId,
      sessionTitle: session.title,
      notes: result.notes,
      generatedAt: new Date(),
    })

    try {
      await ctx.wiki.write(draftPath, markdown)
    } catch (err) {
      return {
        kind: 'error',
        message: `Could not write draft page: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
      }
    }

    return {
      kind: 'text',
      content: renderDistillSummary({
        notes: result.notes,
        draftPath: `${draftPath}.md`,
      }),
    }
  },
})

export function renderDistillSummary(input: {
  notes: DistilledNote[]
  draftPath: string
}): string {
  const lines: string[] = []
  lines.push(`Distilled ${input.notes.length} note${input.notes.length === 1 ? '' : 's'} to wiki/${input.draftPath}`)
  lines.push('')
  const counts = new Map<string, number>()
  for (const n of input.notes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1)
  for (const [kind, count] of [...counts.entries()].sort()) {
    lines.push(`  ${kind}: ${count}`)
  }
  lines.push('')
  lines.push('Review the draft and promote useful entries to canonical wiki pages with wiki_write.')
  return lines.join('\n')
}

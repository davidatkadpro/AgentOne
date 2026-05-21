import { z } from 'zod'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'

export const parameters = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'FTS5 query over indexed project documents. Bare tokens AND together; use OR for disjunction, "..." for phrases, * for prefix.',
    ),
  limit: z.number().int().positive().max(50).default(10),
  offset: z.number().int().nonnegative().default(0),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  try {
    const hits = await ctx.services.documents.search(args.query, {
      limit: args.limit,
      offset: args.offset,
    })
    return ok({
      count: hits.length,
      hits: hits.map((h) => ({ path: h.path, snippet: h.snippet, score: h.score })),
    })
  } catch (err) {
    // FTS5 parse errors surface here as SqliteError. The wiki layer treats
    // them as recoverable validation; mirror that.
    const message = err instanceof Error ? err.message : String(err)
    const looksLikeFtsParse = /fts5:|syntax error|unterminated|malformed MATCH/i.test(message)
    if (looksLikeFtsParse) return fail('TOOL_VALIDATION', `FTS query syntax error: ${message}`, true)
    return fail('TOOL_RUNTIME', message, false)
  }
}

export default { parameters, handler }

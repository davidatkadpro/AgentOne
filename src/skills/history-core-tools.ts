import { z } from 'zod'
import type { RegisteredTool, ToolHandler } from './tool.js'
import { fail, ok } from './tool.js'

const RoleEnum = z.enum(['system', 'user', 'assistant', 'tool'])

const SearchHistoryParams = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'FTS5 query. Bare tokens are AND-ed; use OR between terms for disjunction; wrap with double quotes for phrase match; suffix * for prefix.',
    ),
  limit: z.number().int().positive().max(50).default(10),
  offset: z.number().int().nonnegative().default(0),
  session_id: z
    .string()
    .optional()
    .describe('Restrict to a single session. Mutually exclusive with exclude_session_id.'),
  exclude_session_id: z
    .string()
    .optional()
    .describe(
      'Skip hits from this session. Typically the current session — set to find memories from past conversations only.',
    ),
  roles: z
    .array(RoleEnum)
    .optional()
    .describe('Restrict to specific roles. Default: all roles including tool outputs.'),
})

/**
 * Conversation-history recall via FTS5 over the `turns` table. Always-on Core
 * Tool because `system/memory`'s recall guidance presumes it's available.
 *
 * Queries are passed to FTS5 raw — unlike wiki_search, we don't auto-quote.
 * The agent benefits from operator access (AND/OR/NEAR/prefix*); the tradeoff
 * is that syntactically-invalid queries surface as TOOL_VALIDATION below.
 */
export function buildHistoryCoreTools(): RegisteredTool[] {
  const searchHistory: ToolHandler<typeof SearchHistoryParams> = async (args, ctx) => {
    if (args.session_id && args.exclude_session_id) {
      return fail(
        'TOOL_VALIDATION',
        'session_id and exclude_session_id are mutually exclusive',
        true,
      )
    }
    try {
      const searchOpts: Parameters<typeof ctx.services.recall.searchHistory>[0] = {
        query: args.query,
        limit: args.limit,
        offset: args.offset,
      }
      if (args.session_id !== undefined) searchOpts.sessionId = args.session_id
      if (args.exclude_session_id !== undefined)
        searchOpts.excludeSessionId = args.exclude_session_id
      if (args.roles !== undefined) searchOpts.roles = args.roles
      // Hybrid: FTS5 lexical + vector semantic, merged via reciprocal rank
      // fusion. Falls back to FTS5-only if the embedding provider is missing.
      const hits = await ctx.services.recall.searchHistory(searchOpts)
      return ok({
        count: hits.length,
        hits: hits.map((h) => ({
          session_id: h.sessionId,
          session_title: h.sessionTitle,
          turn_id: h.turnId,
          role: h.role,
          created_at: new Date(h.createdAt).toISOString(),
          snippet: h.snippet,
          content: h.content,
        })),
      })
    } catch (err) {
      // FTS5 query parse failures surface as SqliteError with code
      // SQLITE_ERROR and a message describing the parse error. Programmer
      // bugs (malformed SQL elsewhere) also share that code, so we additionally
      // gate on a message pattern so we don't silently mask real bugs as
      // recoverable validation.
      const message = err instanceof Error ? err.message : String(err)
      const isSqliteError =
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'SQLITE_ERROR'
      const looksLikeFtsParse =
        /fts5:|syntax error|unterminated|malformed MATCH|unknown column/i.test(message)
      if (isSqliteError && looksLikeFtsParse) {
        return fail('TOOL_VALIDATION', `FTS query syntax error: ${message}`, true)
      }
      return fail('TOOL_RUNTIME', message, false)
    }
  }

  return [
    {
      id: 'search_history',
      description:
        'Full-text search over prior conversation turns across all sessions. Returns ranked snippets with session/turn metadata. Useful for recalling what the user told you in earlier conversations.',
      parameters: SearchHistoryParams,
      handler: searchHistory as ToolHandler,
      source: 'core',
    },
  ]
}

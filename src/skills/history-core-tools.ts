import { z } from 'zod'
import type { RegisteredTool, ToolHandler } from './tool.js'
import { fail, ok } from './tool.js'

const RoleEnum = z.enum(['system', 'user', 'assistant', 'tool'])

const DEFAULT_PAGE_SIZE_CHARS = 4000
const MAX_PAGE_SIZE_CHARS = 16_000

const ReadTurnParams = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      'A turn id OR a tool_call_id. Used to rehydrate full content after the 60% rule has truncated a tool result.',
    ),
  page: z.number().int().positive().default(1),
  page_size: z
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_SIZE_CHARS)
    .default(DEFAULT_PAGE_SIZE_CHARS),
})

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

  const readTurn: ToolHandler<typeof ReadTurnParams> = (args, ctx) => {
    // Two lookup paths in order: turn id first (faster + more common when
    // the agent is recalling its own prior outputs), then tool_call_id
    // (the case the 60% truncation rule points to).
    const store = ctx.services.conversationStore
    const turn = store.getTurn(args.id)
    if (turn) {
      return ok(paginate(turn.content, args.page, args.page_size, {
        kind: 'turn',
        id: turn.id,
        sessionId: turn.sessionId,
        role: turn.role,
        createdAt: turn.createdAt,
      }))
    }
    const toolCall = store.getToolCallByLlmId(args.id)
    if (toolCall && toolCall.resultJson !== null) {
      return ok(paginate(toolCall.resultJson, args.page, args.page_size, {
        kind: 'tool_call_result',
        id: toolCall.toolCallId,
        tool: toolCall.tool,
        ok: toolCall.ok,
      }))
    }
    return fail(
      'RESOURCE_UNAVAILABLE',
      `No turn or tool_call found for id "${args.id}"`,
      false,
    )
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
    {
      id: 'read_turn',
      description:
        'Read the full content of a turn or tool result by id, paginated. Use this when the 60% truncation rule has trimmed a tool result you need in full (the truncation marker includes the id to pass back here).',
      parameters: ReadTurnParams,
      handler: readTurn as ToolHandler,
      source: 'core',
    },
  ]
}

interface PageMeta {
  kind: 'turn' | 'tool_call_result'
  id: string
  sessionId?: string
  role?: string
  createdAt?: number
  tool?: string
  ok?: boolean | null
}

/** Slice a string into a page; returns the slice plus pagination metadata
 *  so the agent can iterate without re-counting on the model side. */
function paginate(
  content: string,
  page: number,
  pageSize: number,
  meta: PageMeta,
): {
  meta: PageMeta
  page: number
  page_size: number
  total_pages: number
  total_chars: number
  content: string
} {
  const totalChars = content.length
  const totalPages = Math.max(1, Math.ceil(totalChars / pageSize))
  const clampedPage = Math.min(Math.max(1, page), totalPages)
  const start = (clampedPage - 1) * pageSize
  const slice = content.slice(start, start + pageSize)
  return {
    meta,
    page: clampedPage,
    page_size: pageSize,
    total_pages: totalPages,
    total_chars: totalChars,
    content: slice,
  }
}

import { z } from 'zod'
import { globToRegex } from '../../../../src/core/glob.js'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'

export const parameters = z.object({
  prefix: z
    .string()
    .optional()
    .describe('Subtree to list. Examples: "wiki", "projects/alpha". Omit to list everything.'),
  pattern: z
    .string()
    .optional()
    .describe(
      'Optional glob pattern to filter by file path. Supports * (one segment) and ** (any tail).',
    ),
  limit: z.number().int().positive().default(200),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  try {
    const entries: Array<{ path: string; size: number; mtime: string }> = []
    const re = args.pattern ? globToRegex(args.pattern) : null
    for await (const entry of ctx.services.storage.list(args.prefix)) {
      if (re && !re.test(entry.path)) continue
      entries.push({
        path: entry.path,
        size: entry.size,
        mtime: entry.mtime.toISOString(),
      })
      if (entries.length >= args.limit) break
    }
    return ok({
      count: entries.length,
      truncated: entries.length === args.limit,
      entries,
    })
  } catch (err) {
    return fail(
      'TOOL_RUNTIME',
      err instanceof Error ? err.message : String(err),
      false,
    )
  }
}

export default { parameters, handler }

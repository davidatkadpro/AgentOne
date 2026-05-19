import { z } from 'zod'
import { StorageError } from '../../../../src/storage/adapter.js'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.ts', '.js', '.tsx', '.jsx',
  '.html', '.css', '.csv', '.xml', '.toml', '.ini', '.log',
])

export const parameters = z.object({
  path: z
    .string()
    .describe('POSIX path relative to the storage root (wiki/foo.md, projects/alpha/scope.md, etc.)'),
  max_bytes: z
    .number()
    .int()
    .positive()
    .default(200_000)
    .describe('Maximum bytes to read. Files exceeding this are returned truncated with a notice.'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  try {
    const result = await ctx.services.storage.read(args.path)
    if (!isTextLike(args.path)) {
      return fail(
        'TOOL_VALIDATION',
        `read_file refuses to read non-text path "${args.path}". Use system/documents skill (when available) for binaries.`,
        false,
      )
    }
    const truncated = result.content.length > args.max_bytes
    const slice = truncated ? result.content.subarray(0, args.max_bytes) : result.content
    return ok({
      path: args.path,
      content: slice.toString('utf-8'),
      size: result.size,
      mtime: result.mtime.toISOString(),
      truncated,
    })
  } catch (err) {
    if (err instanceof StorageError) {
      if (err.code === 'NOT_FOUND') {
        return fail('RESOURCE_UNAVAILABLE', `File not found: ${args.path}`, true)
      }
      if (err.code === 'INVALID_PATH') {
        return fail('TOOL_VALIDATION', err.message, true)
      }
    }
    return fail(
      'TOOL_RUNTIME',
      err instanceof Error ? err.message : String(err),
      false,
    )
  }
}

function isTextLike(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return true
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

export default { parameters, handler }

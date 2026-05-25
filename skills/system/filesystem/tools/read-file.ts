import { z } from 'zod'
import { StorageError } from '../../../../src/storage/adapter.js'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.ts', '.js', '.tsx', '.jsx',
  '.html', '.css', '.csv', '.xml', '.toml', '.ini', '.log',
])

// Hard ceiling on file size — files larger than this can't be read at all
// (the agent should reach for read_document or refine the path). Without
// this, a 5GB log file would be slurped into memory just to truncate to
// max_bytes.
const ABSOLUTE_MAX_BYTES = 100 * 1024 * 1024 // 100 MB

export const parameters = z.object({
  path: z
    .string()
    .describe('POSIX path relative to the storage root (wiki/foo.md, projects/alpha/scope.md, etc.)'),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(ABSOLUTE_MAX_BYTES)
    .default(200_000)
    .describe('Maximum bytes to read. Files exceeding this are returned truncated with a notice.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Byte offset to start reading from. Useful for paging through a large file.'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  try {
    if (!isTextLike(args.path)) {
      return fail(
        'TOOL_VALIDATION',
        `read_file refuses to read non-text path "${args.path}". Load the system/documents skill and call read_document for PDF / DOCX / XLSX.`,
        false,
      )
    }

    // Pre-check size so a giant file is never buffered. The historical
    // behaviour read the whole file *then* truncated.
    const meta = await ctx.services.storage.stat(args.path)
    if (meta.size > ABSOLUTE_MAX_BYTES) {
      return fail(
        'RESOURCE_UNAVAILABLE',
        `File too large (${meta.size} bytes > ${ABSOLUTE_MAX_BYTES} byte cap). ` +
          `Read a smaller slice with offset+max_bytes, or use read_document for structured formats.`,
        true,
        { size: meta.size, cap: ABSOLUTE_MAX_BYTES },
      )
    }

    const start = args.offset ?? 0
    if (start >= meta.size) {
      return ok({
        path: args.path,
        content: '',
        size: meta.size,
        mtime: meta.mtime.toISOString(),
        truncated: false,
        offset: start,
      })
    }
    const end = Math.min(meta.size - 1, start + args.max_bytes - 1)
    const result = await ctx.services.storage.readRange(args.path, end, start)
    const remaining = meta.size - (start + result.content.length)
    return ok({
      path: args.path,
      content: result.content.toString('utf-8'),
      size: meta.size,
      mtime: meta.mtime.toISOString(),
      truncated: remaining > 0,
      offset: start,
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

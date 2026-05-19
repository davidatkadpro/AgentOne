import { z } from 'zod'
import { StorageError } from '../../../../src/storage/adapter.js'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'

export const parameters = z.object({
  path: z
    .string()
    .describe('POSIX path relative to the storage root. For markdown under wiki/, prefer wiki_write instead.'),
  content: z.string().describe('UTF-8 text to write. Overwrites any existing file.'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  if (isBinaryExtension(args.path)) {
    return fail(
      'TOOL_VALIDATION',
      `write_file refuses to overwrite binary path "${args.path}". Generated binaries belong in drafts/ as a different format.`,
      false,
    )
  }
  try {
    const stat = await ctx.services.storage.write(args.path, args.content)
    return ok({
      path: args.path,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    })
  } catch (err) {
    if (err instanceof StorageError && err.code === 'INVALID_PATH') {
      return fail('TOOL_VALIDATION', err.message, true)
    }
    return fail(
      'TOOL_RUNTIME',
      err instanceof Error ? err.message : String(err),
      false,
    )
  }
}

function isBinaryExtension(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  const ext = path.slice(dot).toLowerCase()
  return (
    ext === '.pdf' ||
    ext === '.png' ||
    ext === '.jpg' ||
    ext === '.jpeg' ||
    ext === '.gif' ||
    ext === '.webp' ||
    ext === '.zip' ||
    ext === '.docx' ||
    ext === '.xlsx' ||
    ext === '.pptx' ||
    ext === '.dwg' ||
    ext === '.step' ||
    ext === '.stp'
  )
}

export default { parameters, handler }

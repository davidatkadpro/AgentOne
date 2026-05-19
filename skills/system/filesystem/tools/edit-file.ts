import { z } from 'zod'
import { StorageError } from '../../../../src/storage/adapter.js'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'

export const parameters = z.object({
  path: z.string().describe('POSIX path relative to storage root.'),
  find: z
    .string()
    .min(1)
    .describe('Exact substring to replace. Must appear exactly once in the file.'),
  replace: z.string().describe('Replacement text.'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  let text: string
  try {
    text = await ctx.services.storage.readText(args.path)
  } catch (err) {
    if (err instanceof StorageError && err.code === 'NOT_FOUND') {
      return fail('RESOURCE_UNAVAILABLE', `File not found: ${args.path}`, true)
    }
    return fail(
      'TOOL_RUNTIME',
      err instanceof Error ? err.message : String(err),
      false,
    )
  }

  const firstIdx = text.indexOf(args.find)
  if (firstIdx === -1) {
    return fail(
      'TOOL_VALIDATION',
      `Find-string not found in ${args.path}. Include more surrounding context if the file has changed.`,
      true,
    )
  }
  const secondIdx = text.indexOf(args.find, firstIdx + args.find.length)
  if (secondIdx !== -1) {
    return fail(
      'TOOL_VALIDATION',
      `Find-string occurs multiple times in ${args.path} (at ${firstIdx} and ${secondIdx}). Include more context to make it unique.`,
      true,
    )
  }
  const next = text.slice(0, firstIdx) + args.replace + text.slice(firstIdx + args.find.length)
  try {
    const stat = await ctx.services.storage.write(args.path, next)
    return ok({
      path: args.path,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      bytes_delta: next.length - text.length,
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

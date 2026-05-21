import { z } from 'zod'
import { StorageError } from '../../../../src/storage/adapter.js'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'
import {
  detectFormat,
  extractDocx,
  extractPdf,
  extractXlsx,
  parsePageSpec,
  type ExtractedDoc,
  type Format,
} from './extractors.js'

export const parameters = z.object({
  path: z
    .string()
    .describe('POSIX path relative to the storage root (e.g. projects/alpha/scope.pdf)'),
  pages: z
    .string()
    .optional()
    .describe('PDF only. Page selection like "1-3", "1,3,5", or "7". Out-of-range pages are skipped.'),
  sheet: z
    .union([z.string(), z.number().int().nonnegative()])
    .optional()
    .describe('XLSX only. Sheet name or 0-based index. If omitted, every sheet is returned.'),
  max_bytes: z
    .number()
    .int()
    .positive()
    .default(200_000)
    .describe('Cap on returned text size. Default 200 KB.'),
  toc: z
    .boolean()
    .optional()
    .describe('When true, omit body text and return only the section list (PDF outline, DOCX headings, XLSX sheets). Useful before paginating a long document.'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const format = detectFormat(args.path)
  if (!format) {
    return fail(
      'TOOL_VALIDATION',
      `read_document does not handle "${args.path}" — supported extensions: .pdf, .docx, .xlsx, .xls. ` +
        `Use read_file from system/filesystem for plain-text files.`,
      false,
    )
  }

  let buffer: Buffer
  try {
    const read = await ctx.services.storage.read(args.path)
    buffer = read.content
  } catch (err) {
    if (err instanceof StorageError) {
      if (err.code === 'NOT_FOUND') return fail('RESOURCE_UNAVAILABLE', `File not found: ${args.path}`, true)
      if (err.code === 'INVALID_PATH') return fail('TOOL_VALIDATION', err.message, true)
    }
    return fail('TOOL_RUNTIME', err instanceof Error ? err.message : String(err), false)
  }

  try {
    const extracted = await extract(format, buffer, args)
    if (args.toc) {
      return ok({
        path: args.path,
        format,
        toc: extracted.toc,
        toc_count: extracted.toc.length,
        bytes_read: buffer.length,
        ...extracted.meta,
      })
    }
    const truncated = extracted.text.length > args.max_bytes
    const text = truncated ? extracted.text.slice(0, args.max_bytes) : extracted.text
    return ok({
      path: args.path,
      format,
      text,
      truncated,
      bytes_read: buffer.length,
      ...extracted.meta,
    })
  } catch (err) {
    return fail(
      'TOOL_RUNTIME',
      `Failed to parse ${format.toUpperCase()} (${args.path}): ${err instanceof Error ? err.message : String(err)}`,
      false,
    )
  }
}

async function extract(
  format: Format,
  buffer: Buffer,
  args: z.infer<typeof parameters>,
): Promise<ExtractedDoc> {
  if (format === 'pdf') {
    return extractPdf(buffer, args.pages ? parsePageSpec(args.pages) : undefined)
  }
  if (format === 'docx') return extractDocx(buffer)
  return extractXlsx(buffer, args.sheet)
}

export default { parameters, handler }

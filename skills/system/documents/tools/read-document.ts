import { z } from 'zod'
import { PDFParse } from 'pdf-parse'
import * as mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { StorageError } from '../../../../src/storage/adapter.js'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'

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
})

type Format = 'pdf' | 'docx' | 'xlsx'

const EXT_TO_FORMAT: Record<string, Format> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
}

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

interface Extracted {
  text: string
  meta: Record<string, unknown>
}

async function extract(
  format: Format,
  buffer: Buffer,
  args: z.infer<typeof parameters>,
): Promise<Extracted> {
  if (format === 'pdf') return extractPdf(buffer, args.pages)
  if (format === 'docx') return extractDocx(buffer)
  return extractXlsx(buffer, args.sheet)
}

async function extractPdf(buffer: Buffer, pages?: string): Promise<Extracted> {
  const parser = new PDFParse({ data: buffer })
  try {
    const result = pages
      ? await parser.getText({ partial: parsePageSpec(pages) })
      : await parser.getText()
    return {
      text: result.text,
      meta: {
        page_count: result.pages.length,
        page_numbers: result.pages.map((p) => p.num),
      },
    }
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

async function extractDocx(buffer: Buffer): Promise<Extracted> {
  const result = await mammoth.extractRawText({ buffer })
  return {
    text: result.value,
    meta: {
      // mammoth surfaces conversion warnings (unsupported elements etc) here;
      // include them so the agent knows when extraction was lossy.
      messages: result.messages.map((m) => `${m.type}: ${m.message}`),
    },
  }
}

function extractXlsx(buffer: Buffer, sheet?: string | number): Extracted {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const sheetNames = workbook.SheetNames
  const selected = selectSheets(sheetNames, sheet)
  if (selected.length === 0) {
    throw new Error(
      `Sheet "${sheet}" not found. Available: ${sheetNames.join(', ')}`,
    )
  }
  const parts: string[] = []
  for (const name of selected) {
    const ws = workbook.Sheets[name]
    if (!ws) continue
    const csv = XLSX.utils.sheet_to_csv(ws, { FS: '\t' })
    parts.push(`## Sheet: ${name}\n\n${csv.trimEnd()}`)
  }
  return {
    text: parts.join('\n\n'),
    meta: {
      sheets: sheetNames,
      sheets_returned: selected,
    },
  }
}

function selectSheets(names: string[], sheet?: string | number): string[] {
  if (sheet === undefined) return names
  if (typeof sheet === 'number') {
    return sheet >= 0 && sheet < names.length ? [names[sheet]!] : []
  }
  return names.includes(sheet) ? [sheet] : []
}

function parsePageSpec(spec: string): number[] {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const dash = trimmed.indexOf('-')
    if (dash === -1) {
      const n = Number(trimmed)
      if (Number.isInteger(n) && n > 0) out.add(n)
    } else {
      const start = Number(trimmed.slice(0, dash))
      const end = Number(trimmed.slice(dash + 1))
      if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) {
        for (let i = start; i <= end; i++) out.add(i)
      }
    }
  }
  return [...out].sort((a, b) => a - b)
}

function detectFormat(path: string): Format | null {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return null
  return EXT_TO_FORMAT[path.slice(dot).toLowerCase()] ?? null
}

export default { parameters, handler }

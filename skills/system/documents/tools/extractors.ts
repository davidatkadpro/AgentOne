// Shared extractors used by read_document (one-off, paginated) and
// doc_search (bulk indexing). Kept as plain functions so the doc-search
// indexer in src/memory can call them without pulling in the whole skill.
import { PDFParse } from 'pdf-parse'
import * as mammoth from 'mammoth'
import * as XLSX from 'xlsx'

export type Format = 'pdf' | 'docx' | 'xlsx'

export const EXT_TO_FORMAT: Record<string, Format> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
}

export function detectFormat(path: string): Format | null {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return null
  return EXT_TO_FORMAT[path.slice(dot).toLowerCase()] ?? null
}

export interface ExtractedDoc {
  text: string
  /** Per-format metadata (page count, sheet names, etc). */
  meta: Record<string, unknown>
  /** Section list: ordered headings or sheet names with text positions where
   *  available. Empty array if the format doesn't expose structure. */
  toc: Array<{ title: string; level?: number; page?: number }>
}

export async function extractPdf(buffer: Buffer, pages?: number[]): Promise<ExtractedDoc> {
  const parser = new PDFParse({ data: buffer })
  try {
    const result = pages
      ? await parser.getText({ partial: pages })
      : await parser.getText()
    // Outline (bookmarks) live on the InfoResult, not as a separate method.
    // pdf-parse mirrors PDF.js's structure — items[] for nested entries.
    let toc: ExtractedDoc['toc'] = []
    try {
      const info = await parser.getInfo()
      if (info.outline && info.outline.length > 0) {
        toc = flattenOutline(info.outline)
      }
    } catch {
      // Not all PDFs expose an outline — that's normal, not an error.
    }
    return {
      text: result.text,
      meta: {
        page_count: result.pages.length,
        page_numbers: result.pages.map((p) => p.num),
      },
      toc,
    }
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

interface PdfOutlineNode {
  title?: string
  items?: Array<unknown>
}

function flattenOutline(
  nodes: Array<unknown>,
  level = 1,
): ExtractedDoc['toc'] {
  const out: ExtractedDoc['toc'] = []
  for (const raw of nodes) {
    const node = raw as PdfOutlineNode
    if (typeof node.title === 'string' && node.title.length > 0) {
      out.push({ title: node.title, level })
    }
    if (Array.isArray(node.items) && node.items.length > 0) {
      out.push(...flattenOutline(node.items, level + 1))
    }
  }
  return out
}

export async function extractDocx(buffer: Buffer): Promise<ExtractedDoc> {
  // Use convertToHtml + extractRawText: HTML for TOC, raw text for body.
  // mammoth's HTML output uses <h1>..<h6> for Word's heading styles.
  const [htmlResult, rawResult] = await Promise.all([
    mammoth.convertToHtml({ buffer }),
    mammoth.extractRawText({ buffer }),
  ])
  const toc = extractDocxToc(htmlResult.value)
  return {
    text: rawResult.value,
    meta: {
      messages: rawResult.messages.map((m) => `${m.type}: ${m.message}`),
    },
    toc,
  }
}

const HEADING_RE = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi

function extractDocxToc(html: string): ExtractedDoc['toc'] {
  const out: ExtractedDoc['toc'] = []
  let m: RegExpExecArray | null
  while ((m = HEADING_RE.exec(html)) !== null) {
    const level = Number(m[1].slice(1))
    const title = m[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
    if (title.length > 0) out.push({ title, level })
  }
  return out
}

export function extractXlsx(buffer: Buffer, sheet?: string | number): ExtractedDoc {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const sheetNames = workbook.SheetNames
  const selected = selectSheets(sheetNames, sheet)
  if (selected.length === 0) {
    throw new Error(`Sheet "${sheet}" not found. Available: ${sheetNames.join(', ')}`)
  }
  const parts: string[] = []
  for (const name of selected) {
    const ws = workbook.Sheets[name]
    if (!ws) continue
    const csv = XLSX.utils.sheet_to_csv(ws, { FS: '\t' })
    parts.push(`## Sheet: ${name}\n\n${csv.trimEnd()}`)
  }
  // For XLSX, the TOC is the sheet list — useful even when there's no other
  // structure inside each sheet.
  return {
    text: parts.join('\n\n'),
    meta: {
      sheets: sheetNames,
      sheets_returned: selected,
    },
    toc: sheetNames.map((n, i) => ({ title: n, level: 1, page: i + 1 })),
  }
}

function selectSheets(names: string[], sheet?: string | number): string[] {
  if (sheet === undefined) return names
  if (typeof sheet === 'number') {
    return sheet >= 0 && sheet < names.length ? [names[sheet]!] : []
  }
  return names.includes(sheet) ? [sheet] : []
}

export function parsePageSpec(spec: string): number[] {
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

/**
 * Top-level dispatcher: extract a document by detected format. Used by
 * doc-search's indexer to populate FTS5 across all `projects/` files.
 * Returns null when the format isn't supported (binary, image, etc.).
 */
export async function extractByFormat(path: string, buffer: Buffer): Promise<ExtractedDoc | null> {
  const format = detectFormat(path)
  if (!format) return null
  if (format === 'pdf') return extractPdf(buffer)
  if (format === 'docx') return extractDocx(buffer)
  return extractXlsx(buffer)
}

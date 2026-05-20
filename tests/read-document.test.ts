import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import type { ToolContext } from '@/skills/tool.js'
import type { WikiEngine } from '@/memory/wiki/engine.js'
import type { ConversationStore } from '@/storage/sqlite.js'
import type { HybridRecall } from '@/search/hybrid.js'
import type { PermissionGate } from '@/profiles/permission-gate.js'
import { ProviderRegistry } from '@/providers/registry.js'
import { ExpertSpendTracker } from '@/skills/expert-spend.js'
import { EventBus } from '@/core/events.js'
import { handler as readDocument } from '../skills/system/documents/tools/read-document.js'

// A minimal valid PDF rendering the literal string "Hello PDF". Built from
// scratch (xref table + 4 objects) so the test has no external fixture file.
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const streamBuf = Buffer.from(stream, 'latin1')
  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`,
    `4 0 obj\n<< /Length ${streamBuf.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += obj
  }
  const xrefStart = Buffer.byteLength(body, 'latin1')
  let xref = `xref\n0 ${objects.length + 1}\n`
  xref += `0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(body + xref + trailer, 'latin1')
}

// Minimal DOCX as a flat zip with the bare-minimum parts mammoth needs.
async function minimalDocx(text: string): Promise<Buffer> {
  // Lazy import jszip-like behaviour via the well-known yauzl/yazl, but
  // those aren't deps. We build the ZIP by hand — DOCX-readers only need
  // the central directory + a couple of XML parts.
  // For test purposes, use the JSZip-equivalent that mammoth itself
  // depends on: `@xmldom/xmldom` is mammoth's runtime dep, NOT a zipper.
  // Easier: use node's built-in zlib + a hand-rolled ZIP. But that's a lot.
  // Simplest: import jszip via mammoth's tree (mammoth depends on jszip).
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  )
  return await zip.generateAsync({ type: 'nodebuffer' })
}

function xlsxBuffer(rows: Array<Record<string, string | number>>, sheetName = 'Sheet1'): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

function multiSheetXlsx(): Buffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ a: 1, b: 2 }]), 'Summary')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ x: 10, y: 20 }]), 'Detail')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

let root: string
let adapter: LocalFolderAdapter

function makeCtx(): ToolContext {
  return {
    sessionId: 's1',
    agentProfile: 'test',
    services: {
      storage: adapter,
      wiki: {} as unknown as WikiEngine,
      conversationStore: {} as unknown as ConversationStore,
      recall: {} as unknown as HybridRecall,
      providers: new ProviderRegistry(),
      modelProfiles: new Map(),
      eventBus: new EventBus(),
    },
    permissions: {} as unknown as PermissionGate,
    expertSpend: new ExpertSpendTracker(),
  }
}

describe('read_document', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentone-docs-'))
    adapter = new LocalFolderAdapter({ root })
    await mkdir(join(root, 'projects'), { recursive: true })
    await writeFile(join(root, 'projects', 'hello.pdf'), minimalPdf('Hello PDF'))
    await writeFile(join(root, 'projects', 'note.docx'), await minimalDocx('Hello DOCX world.'))
    await writeFile(
      join(root, 'projects', 'sheet.xlsx'),
      xlsxBuffer([
        { name: 'Alice', score: 95 },
        { name: 'Bob', score: 82 },
      ]),
    )
    await writeFile(join(root, 'projects', 'multi.xlsx'), multiSheetXlsx())
    await writeFile(join(root, 'projects', 'plain.txt'), 'just text')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('extracts text from a minimal PDF', async () => {
    const result = await readDocument({ path: 'projects/hello.pdf', max_bytes: 100_000 }, makeCtx())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    const value = result.value as { format: string; text: string; page_count: number }
    expect(value.format).toBe('pdf')
    expect(value.page_count).toBe(1)
    expect(value.text).toContain('Hello PDF')
  })

  it('extracts text from a DOCX file', async () => {
    const result = await readDocument({ path: 'projects/note.docx', max_bytes: 100_000 }, makeCtx())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    const value = result.value as { format: string; text: string }
    expect(value.format).toBe('docx')
    expect(value.text).toContain('Hello DOCX world.')
  })

  it('extracts a single-sheet XLSX as tab-separated rows', async () => {
    const result = await readDocument({ path: 'projects/sheet.xlsx', max_bytes: 100_000 }, makeCtx())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    const value = result.value as { format: string; text: string; sheets: string[] }
    expect(value.format).toBe('xlsx')
    expect(value.sheets).toEqual(['Sheet1'])
    expect(value.text).toContain('## Sheet: Sheet1')
    expect(value.text).toContain('Alice')
    expect(value.text).toContain('95')
  })

  it('selects a sheet by name when sheet= is given', async () => {
    const result = await readDocument(
      { path: 'projects/multi.xlsx', sheet: 'Detail', max_bytes: 100_000 },
      makeCtx(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    const value = result.value as { text: string; sheets_returned: string[] }
    expect(value.sheets_returned).toEqual(['Detail'])
    expect(value.text).not.toContain('## Sheet: Summary')
    expect(value.text).toContain('## Sheet: Detail')
  })

  it('selects a sheet by 0-based index when sheet= is a number', async () => {
    const result = await readDocument(
      { path: 'projects/multi.xlsx', sheet: 0, max_bytes: 100_000 },
      makeCtx(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    const value = result.value as { sheets_returned: string[] }
    expect(value.sheets_returned).toEqual(['Summary'])
  })

  it('returns a clear error when the requested sheet is missing', async () => {
    const result = await readDocument(
      { path: 'projects/multi.xlsx', sheet: 'Nonexistent', max_bytes: 100_000 },
      makeCtx(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.message).toMatch(/Nonexistent/)
  })

  it('truncates output at max_bytes and reports truncated=true', async () => {
    const result = await readDocument(
      { path: 'projects/sheet.xlsx', max_bytes: 10 },
      makeCtx(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    const value = result.value as { truncated: boolean; text: string }
    expect(value.truncated).toBe(true)
    expect(value.text.length).toBe(10)
  })

  it('rejects unsupported extensions with a redirect to read_file', async () => {
    const result = await readDocument({ path: 'projects/plain.txt', max_bytes: 100_000 }, makeCtx())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('TOOL_VALIDATION')
    expect(result.error.message).toMatch(/read_file/)
  })

  it('returns RESOURCE_UNAVAILABLE for a missing file', async () => {
    const result = await readDocument(
      { path: 'projects/does-not-exist.pdf', max_bytes: 100_000 },
      makeCtx(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('RESOURCE_UNAVAILABLE')
  })
})

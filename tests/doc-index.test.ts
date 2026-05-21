import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import { createDatabase, type Db } from '@/storage/db.js'
import { DocumentIndex } from '@/memory/documents/doc-index.js'

let root: string
let db: Db

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentone-docidx-'))
  db = createDatabase({ path: ':memory:', skipMkdir: true })
})

afterEach(async () => {
  db.close()
  await rm(root, { recursive: true, force: true })
})

async function plantFile(path: string, content: string): Promise<void> {
  const abs = join(root, path)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf-8')
}

function buildIndex(extractTextAs?: (path: string, content: Buffer) => string): DocumentIndex {
  return new DocumentIndex({
    storage: new LocalFolderAdapter({ root }),
    db,
    prefix: 'projects',
    extract: async (path, content) => {
      if (extractTextAs) return extractTextAs(path, content)
      // Treat every file's bytes as raw text. Simplifies tests away from real
      // PDF/DOCX extractors.
      return content.toString('utf-8')
    },
  })
}

describe('DocumentIndex.ensureFresh', () => {
  it('indexes new files on first call', async () => {
    await plantFile('projects/a.txt', 'apple banana cherry')
    await plantFile('projects/b.txt', 'date eggplant fig')
    const idx = buildIndex()
    const stats = await idx.ensureFresh()
    expect(stats.added).toBe(2)
    expect(stats.updated).toBe(0)
    expect(stats.deleted).toBe(0)
  })

  it('skips re-extraction when mtime/size are unchanged', async () => {
    await plantFile('projects/a.txt', 'apple')
    let extractCalls = 0
    const idx = buildIndex((_p, c) => {
      extractCalls++
      return c.toString('utf-8')
    })
    await idx.ensureFresh()
    await idx.ensureFresh()
    expect(extractCalls).toBe(1)
  })

  it('re-extracts when a file is touched', async () => {
    const abs = join(root, 'projects/a.txt')
    await plantFile('projects/a.txt', 'apple')
    let extractCalls = 0
    const idx = buildIndex((_p, c) => {
      extractCalls++
      return c.toString('utf-8')
    })
    await idx.ensureFresh()
    expect(extractCalls).toBe(1)

    // Bump mtime by 5 seconds.
    const future = new Date(Date.now() + 5_000)
    await utimes(abs, future, future)
    const stats = await idx.ensureFresh()
    expect(stats.updated).toBe(1)
    expect(extractCalls).toBe(2)
  })

  it('prunes rows when a file is deleted', async () => {
    await plantFile('projects/a.txt', 'apple')
    await plantFile('projects/b.txt', 'banana')
    const idx = buildIndex()
    await idx.ensureFresh()

    await rm(join(root, 'projects/a.txt'))
    const stats = await idx.ensureFresh()
    expect(stats.deleted).toBe(1)
  })

  it('skips files for which the extractor returns null', async () => {
    await plantFile('projects/a.txt', 'apple')
    await plantFile('projects/b.bin', 'BINARY')
    const idx = buildIndex((path) => (path.endsWith('.bin') ? null! : 'extracted'))
    // The extractor returns null for .bin; cast above forces TS to accept the
    // signature. We're testing that the index respects null = "skip".
    const stats = await idx.ensureFresh()
    expect(stats.added).toBe(1)
  })
})

describe('DocumentIndex.search', () => {
  it('FTS5-matches against extracted text', async () => {
    await plantFile('projects/a.txt', 'the platypus is unusual')
    await plantFile('projects/b.txt', 'the marsupial is also unusual')
    const idx = buildIndex()
    const hits = await idx.search('platypus')
    expect(hits.length).toBe(1)
    expect(hits[0].path).toBe('projects/a.txt')
  })

  it('returns multiple hits with snippets', async () => {
    await plantFile('projects/a.txt', 'cosmic radiation in the upper atmosphere')
    await plantFile('projects/b.txt', 'cosmic background microwave')
    const idx = buildIndex()
    const hits = await idx.search('cosmic')
    expect(hits.length).toBe(2)
    for (const h of hits) {
      expect(h.snippet.toLowerCase()).toContain('cosmic')
    }
  })

  it('honours limit + offset', async () => {
    for (let i = 0; i < 5; i++) {
      await plantFile(`projects/${i}.txt`, `marker file number ${i}`)
    }
    const idx = buildIndex()
    const firstPage = await idx.search('marker', { limit: 2, offset: 0 })
    const secondPage = await idx.search('marker', { limit: 2, offset: 2 })
    expect(firstPage.length).toBe(2)
    expect(secondPage.length).toBe(2)
    const overlap = firstPage.find((a) => secondPage.find((b) => b.path === a.path))
    expect(overlap).toBeUndefined()
  })

  it('returns empty for whitespace queries', async () => {
    await plantFile('projects/a.txt', 'content')
    const idx = buildIndex()
    expect(await idx.search('')).toEqual([])
    expect(await idx.search('   ')).toEqual([])
  })

  it('emits negative-style rank scores (smaller = better)', async () => {
    await plantFile('projects/a.txt', 'platypus '.repeat(20))
    await plantFile('projects/b.txt', 'platypus once mentioned')
    const idx = buildIndex()
    const hits = await idx.search('platypus')
    expect(hits.length).toBe(2)
    // FTS5 rank: more matches → more negative score. The "many platypus"
    // doc should rank first (smaller score).
    expect(hits[0].path).toBe('projects/a.txt')
    expect(hits[0].score).toBeLessThan(hits[1].score)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFolderAdapter } from '../src/storage/local-folder.js'

describe('LocalFolderAdapter.list — iterative', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentone-list-iter-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('yields entries lazily — break stops the walk', async () => {
    // Seed 100 files across 10 subdirs.
    for (let d = 0; d < 10; d++) {
      mkdirSync(join(root, `dir${d}`), { recursive: true })
      for (let f = 0; f < 10; f++) {
        writeFileSync(join(root, `dir${d}`, `f${f}.txt`), 'x', 'utf-8')
      }
    }
    const adapter = new LocalFolderAdapter({ root })
    const seen: string[] = []
    for await (const entry of adapter.list()) {
      seen.push(entry.path)
      if (seen.length >= 5) break
    }
    expect(seen.length).toBe(5)
  })

  it('walks nested directories (regression of recursive: true behaviour)', async () => {
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(root, 'top.txt'), 'x', 'utf-8')
    writeFileSync(join(root, 'a', 'mid.txt'), 'x', 'utf-8')
    writeFileSync(join(root, 'a', 'b', 'deep.txt'), 'x', 'utf-8')
    writeFileSync(join(root, 'a', 'b', 'c', 'leaf.txt'), 'x', 'utf-8')

    const adapter = new LocalFolderAdapter({ root })
    const paths: string[] = []
    for await (const entry of adapter.list()) {
      paths.push(entry.path)
    }
    expect(paths.sort()).toEqual([
      'a/b/c/leaf.txt',
      'a/b/deep.txt',
      'a/mid.txt',
      'top.txt',
    ])
  })

  it('respects a prefix', async () => {
    mkdirSync(join(root, 'wiki', 'inner'), { recursive: true })
    writeFileSync(join(root, 'wiki', 'a.md'), 'x', 'utf-8')
    writeFileSync(join(root, 'wiki', 'inner', 'b.md'), 'x', 'utf-8')
    writeFileSync(join(root, 'other.md'), 'x', 'utf-8')

    const adapter = new LocalFolderAdapter({ root })
    const paths: string[] = []
    for await (const entry of adapter.list('wiki')) paths.push(entry.path)
    expect(paths.sort()).toEqual(['wiki/a.md', 'wiki/inner/b.md'])
  })

  it('returns empty when the prefix does not exist', async () => {
    const adapter = new LocalFolderAdapter({ root })
    let count = 0
    for await (const _ of adapter.list('not-there')) count++
    expect(count).toBe(0)
  })
})

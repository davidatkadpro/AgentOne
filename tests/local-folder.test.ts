import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import { StorageError } from '@/storage/adapter.js'

describe('LocalFolderAdapter', () => {
  let root: string
  let adapter: LocalFolderAdapter

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentone-storage-'))
    adapter = new LocalFolderAdapter({ root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('rejects construction with a relative root', () => {
    expect(() => new LocalFolderAdapter({ root: 'relative/path' })).toThrow(StorageError)
  })

  it('writes a string, reads it back, and reports stat metadata', async () => {
    await adapter.write('notes/hello.md', '# Hello\n\nworld.')
    const text = await adapter.readText('notes/hello.md')
    expect(text).toBe('# Hello\n\nworld.')

    const res = await adapter.read('notes/hello.md')
    expect(res.content.toString('utf-8')).toBe('# Hello\n\nworld.')
    expect(res.size).toBe(Buffer.byteLength('# Hello\n\nworld.'))
    expect(res.mtime).toBeInstanceOf(Date)
  })

  it('auto-creates parent directories on write', async () => {
    await adapter.write('a/b/c/deep.md', 'x')
    const actual = await readFile(join(root, 'a', 'b', 'c', 'deep.md'), 'utf-8')
    expect(actual).toBe('x')
  })

  it('exists returns true for files, false for missing', async () => {
    expect(await adapter.exists('absent.md')).toBe(false)
    await adapter.write('here.md', 'x')
    expect(await adapter.exists('here.md')).toBe(true)
  })

  it('read of a missing file throws StorageError(NOT_FOUND)', async () => {
    await expect(adapter.read('missing.md')).rejects.toMatchObject({
      name: 'StorageError',
      code: 'NOT_FOUND',
    })
  })

  it('delete of a missing file is a no-op', async () => {
    await expect(adapter.delete('missing.md')).resolves.toBeUndefined()
  })

  it('rejects path traversal attempts', async () => {
    await expect(adapter.read('../escape.md')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(adapter.read('a/../../escape.md')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    })
  })

  it('rejects absolute paths', async () => {
    await expect(adapter.read('/abs/path.md')).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it('list yields every file recursively under prefix', async () => {
    await adapter.write('wiki/a.md', 'a')
    await adapter.write('wiki/sub/b.md', 'b')
    await adapter.write('projects/c.txt', 'c')

    const wiki: string[] = []
    for await (const e of adapter.list('wiki')) wiki.push(e.path)
    expect(wiki.sort()).toEqual(['wiki/a.md', 'wiki/sub/b.md'])

    const all: string[] = []
    for await (const e of adapter.list()) all.push(e.path)
    expect(all.sort()).toEqual(['projects/c.txt', 'wiki/a.md', 'wiki/sub/b.md'])
  })

  it('list of a missing prefix yields nothing without error', async () => {
    const found: string[] = []
    for await (const e of adapter.list('does-not-exist')) found.push(e.path)
    expect(found).toEqual([])
  })

  it('overwrites an existing file', async () => {
    await adapter.write('x.md', 'first')
    await adapter.write('x.md', 'second')
    expect(await adapter.readText('x.md')).toBe('second')
  })
})

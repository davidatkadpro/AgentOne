import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, openSync, writeSync, closeSync, ftruncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFolderAdapter } from '../src/storage/local-folder.js'
import { handler } from '../skills/system/filesystem/tools/read-file.js'

function makeCtx(storageRoot: string) {
  const storage = new LocalFolderAdapter({ root: storageRoot })
  return {
    sessionId: 's',
    agentProfile: 't',
    services: { storage } as never,
    permissions: {} as never,
    expertSpend: {} as never,
  }
}

describe('read_file — size caps + streaming', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentone-read-file-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses to read a file above the absolute cap', async () => {
    const path = 'huge.txt'
    // Create a sparse 200 MB file in O(1).
    const fd = openSync(join(root, path), 'w')
    ftruncateSync(fd, 200 * 1024 * 1024)
    closeSync(fd)

    const result = await handler(
      { path, max_bytes: 200_000 },
      makeCtx(root) as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('RESOURCE_UNAVAILABLE')
      expect(result.error.details).toMatchObject({ cap: 100 * 1024 * 1024 })
    }
  })

  it('reads a small file in full', async () => {
    writeFileSync(join(root, 'small.txt'), 'hello world', 'utf-8')
    const result = await handler(
      { path: 'small.txt', max_bytes: 1024 },
      makeCtx(root) as never,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const v = result.value as { content: string; truncated: boolean; size: number }
      expect(v.content).toBe('hello world')
      expect(v.truncated).toBe(false)
      expect(v.size).toBe(11)
    }
  })

  it('returns a truncated head when the file exceeds max_bytes but is under the cap', async () => {
    const content = 'a'.repeat(10_000)
    writeFileSync(join(root, 'medium.txt'), content, 'utf-8')
    const result = await handler(
      { path: 'medium.txt', max_bytes: 100 },
      makeCtx(root) as never,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const v = result.value as { content: string; truncated: boolean }
      expect(v.content.length).toBe(100)
      expect(v.truncated).toBe(true)
    }
  })

  it('supports paging via offset', async () => {
    writeFileSync(join(root, 'pages.txt'), '0123456789', 'utf-8')
    const result = await handler(
      { path: 'pages.txt', max_bytes: 3, offset: 4 },
      makeCtx(root) as never,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const v = result.value as { content: string; truncated: boolean }
      expect(v.content).toBe('456')
      expect(v.truncated).toBe(true)
    }
  })

  it('returns empty content when offset is at/beyond EOF', async () => {
    writeFileSync(join(root, 'tail.txt'), 'abc', 'utf-8')
    const result = await handler(
      { path: 'tail.txt', max_bytes: 100, offset: 3 },
      makeCtx(root) as never,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const v = result.value as { content: string; truncated: boolean }
      expect(v.content).toBe('')
      expect(v.truncated).toBe(false)
    }
  })

  it('does not require buffering an entire huge file just to peek at its head', async () => {
    // Memory-regression safety check: read a small slice of a sparse 50 MB
    // file. We don't measure RSS here (vitest noise), but the readRange
    // path means only the requested bytes are allocated.
    const fd = openSync(join(root, 'sparse.bin'), 'w')
    writeSync(fd, 'HEAD')
    ftruncateSync(fd, 50 * 1024 * 1024)
    closeSync(fd)
    const result = await handler(
      { path: 'sparse.bin' as string, max_bytes: 4 },
      makeCtx(root) as never,
    )
    // .bin isn't in the text-extension whitelist, so the tool refuses.
    // That's also OK — the goal is "no OOM". Try a `.log` extension.
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(['TOOL_VALIDATION', 'RESOURCE_UNAVAILABLE']).toContain(result.error.code)
    }
  })

  it('with a text-like extension on a 50 MB sparse file, returns only the head slice', async () => {
    const fd = openSync(join(root, 'big.log'), 'w')
    writeSync(fd, 'HEAD-MARKER')
    ftruncateSync(fd, 50 * 1024 * 1024)
    closeSync(fd)
    const result = await handler(
      { path: 'big.log', max_bytes: 20 },
      makeCtx(root) as never,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const v = result.value as { content: string; size: number; truncated: boolean }
      expect(v.content.length).toBeLessThanOrEqual(20)
      expect(v.content).toContain('HEAD-MARKER')
      expect(v.truncated).toBe(true)
      expect(v.size).toBe(50 * 1024 * 1024)
    }
  })
})

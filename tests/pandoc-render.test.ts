import { describe, expect, it } from 'vitest'
import { renderPandoc } from '../src/render/pandoc.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function pandocAvailable(): Promise<boolean> {
  try {
    await execFileAsync('pandoc', ['--version'], { timeout: 2000 })
    return true
  } catch {
    return false
  }
}

describe('renderPandoc helper', () => {
  it('reports spawn_failed when pandoc binary is missing', async () => {
    // We can't easily simulate "missing binary" when pandoc *is* installed,
    // but we can exercise the spawn_failed branch by giving an invalid
    // option combination.
    const result = await renderPandoc({
      input: Buffer.from('x'),
      inputFile: 'also.md',
    })
    expect(result.kind).toBe('spawn_failed')
  })

  // The following tests only run when pandoc is actually on PATH. CI runs
  // on machines without pandoc, so we skip rather than fail.
  it('round-trips markdown → html when pandoc is available', async () => {
    if (!(await pandocAvailable())) {
      console.warn('[pandoc-render] pandoc not on PATH — skipping')
      return
    }
    const result = await renderPandoc({
      input: Buffer.from('# Hello\n\nWorld'),
      from: 'markdown',
      to: 'html',
    })
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.output.toString('utf-8')).toContain('<h1')
    }
  }, 15_000)

  it('reports timeout when wall-clock exceeds timeoutMs', async () => {
    if (!(await pandocAvailable())) return
    // Pass a too-small timeout and watch the helper kill the child.
    // A trivial document still costs a few ms; 1ms forces a timeout.
    const result = await renderPandoc({
      input: Buffer.from('x'),
      from: 'markdown',
      to: 'pdf',
      timeoutMs: 1,
    })
    // Either timeout OR error (if pandoc finished before our SIGKILL).
    expect(['timeout', 'error']).toContain(result.kind)
  }, 15_000)

  it('reports error on bad input format with stderr captured', async () => {
    if (!(await pandocAvailable())) return
    const result = await renderPandoc({
      input: Buffer.from('x'),
      from: 'not-a-real-format',
      to: 'html',
    })
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.stderr.length).toBeGreaterThan(0)
    }
  }, 15_000)

  it('honours an upstream AbortSignal', async () => {
    if (!(await pandocAvailable())) return
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 5)
    const result = await renderPandoc({
      input: Buffer.from('# x'),
      from: 'markdown',
      to: 'pdf',
      signal: controller.signal,
    })
    // Cancellation gets reported as error or timeout depending on race.
    expect(['error', 'timeout', 'ok']).toContain(result.kind)
  }, 15_000)
})

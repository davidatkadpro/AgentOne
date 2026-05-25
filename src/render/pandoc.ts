/**
 * Shared Pandoc helper. Replaces ad-hoc `execFile('pandoc', …)` calls scattered
 * across invoice/proposal renderers. Centralised so we can:
 *
 *   - enforce a default 30s timeout on every invocation
 *   - drain stdout *and* stderr concurrently (a blocked stderr pipe stalls
 *     pandoc indefinitely when it writes warnings)
 *   - cap both output streams (a runaway template can produce GBs of PDF)
 *   - report structured success/failure with stderr snippets for debugging
 *   - kill the child on timeout or upstream abort
 *
 * No format defaults — callers pass `from` / `to` / extra args. We never
 * pass `--from gfm+raw_html`; safer template renderers should be set up at
 * the call site (R15).
 */

import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024 // 64 MB — enough for a long PDF
const DEFAULT_MAX_STDERR = 1 * 1024 * 1024 // 1 MB — enough for a useful snippet

export interface RenderPandocOptions {
  /** Input as a UTF-8 buffer fed on stdin. Mutually exclusive with `inputFile`. */
  input?: Buffer
  /** Path to read input from instead of stdin. */
  inputFile?: string
  /** Output destination — when set, pandoc writes to disk and we return an
   *  empty `output` buffer with size on success. */
  outputFile?: string
  /** Source format, e.g. `'markdown'`, `'gfm'`. Required unless inputFile
   *  has a recognised extension and you want pandoc to guess. */
  from?: string
  /** Target format. */
  to?: string
  /** Extra positional/long args (e.g. `['--standalone']`). */
  extraArgs?: string[]
  /** Kill after this many ms. Default 30_000. */
  timeoutMs?: number
  /** Max captured stdout bytes. Default 64 MiB. */
  maxStdoutBytes?: number
  /** Max captured stderr bytes. Default 1 MiB. */
  maxStderrBytes?: number
  /** Upstream cancellation (turn cancel, tool timeout). */
  signal?: AbortSignal
}

export type RenderPandocResult =
  | {
      kind: 'ok'
      /** Captured stdout — empty when `outputFile` was set. */
      output: Buffer
      stderr: string
      durationMs: number
    }
  | {
      kind: 'timeout'
      stderr: string
      durationMs: number
    }
  | {
      kind: 'error'
      exitCode: number | null
      signal: NodeJS.Signals | null
      stderr: string
      durationMs: number
    }
  | {
      kind: 'spawn_failed'
      error: string
    }

export async function renderPandoc(opts: RenderPandocOptions): Promise<RenderPandocResult> {
  if (opts.input && opts.inputFile) {
    return { kind: 'spawn_failed', error: 'renderPandoc: pass input OR inputFile, not both' }
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT
  const maxStderr = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR

  const args: string[] = []
  if (opts.from) args.push('-f', opts.from)
  if (opts.to) args.push('-t', opts.to)
  if (opts.outputFile) args.push('-o', opts.outputFile)
  if (opts.extraArgs) args.push(...opts.extraArgs)
  args.push(opts.inputFile ?? '-') // '-' = stdin

  return new Promise((resolve) => {
    const start = Date.now()
    const child = spawn('pandoc', args, {
      stdio: [opts.input ? 'pipe' : (opts.inputFile ? 'ignore' : 'pipe'), 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let timedOut = false
    let cancelled = false

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        const remaining = maxStdout - stdoutBytes
        if (remaining <= 0) {
          stdoutTruncated = true
          return
        }
        if (chunk.byteLength > remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining))
          stdoutBytes += remaining
          stdoutTruncated = true
          child.kill('SIGKILL')
        } else {
          stdoutChunks.push(chunk)
          stdoutBytes += chunk.byteLength
        }
      })
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        const remaining = maxStderr - stderrBytes
        if (remaining <= 0) {
          stderrTruncated = true
          return
        }
        if (chunk.byteLength > remaining) {
          stderrChunks.push(chunk.subarray(0, remaining))
          stderrBytes += remaining
          stderrTruncated = true
        } else {
          stderrChunks.push(chunk)
          stderrBytes += chunk.byteLength
        }
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, timeoutMs)

    const onAbort = (): void => {
      cancelled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      resolve({ kind: 'spawn_failed', error: err.message })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      const durationMs = Date.now() - start
      const stderr =
        Buffer.concat(stderrChunks).toString('utf-8') +
        (stderrTruncated ? '\n[... stderr truncated ...]' : '')

      if (cancelled) {
        resolve({
          kind: 'error',
          exitCode: code,
          signal,
          stderr: stderr || 'cancelled',
          durationMs,
        })
        return
      }
      if (timedOut) {
        resolve({ kind: 'timeout', stderr, durationMs })
        return
      }
      if (code !== 0) {
        resolve({ kind: 'error', exitCode: code, signal, stderr, durationMs })
        return
      }
      const output = Buffer.concat(stdoutChunks)
      // If stdout was truncated mid-stream, treat that as an error rather
      // than returning a corrupted document.
      if (stdoutTruncated) {
        resolve({
          kind: 'error',
          exitCode: code,
          signal,
          stderr: `stdout exceeded ${maxStdout} bytes\n${stderr}`,
          durationMs,
        })
        return
      }
      resolve({ kind: 'ok', output, stderr, durationMs })
    })

    if (opts.input && child.stdin) {
      child.stdin.write(opts.input)
      child.stdin.end()
    }
  })
}

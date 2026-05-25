import { z } from 'zod'
import { spawn, exec } from 'node:child_process'
import { isAbsolute, resolve, relative } from 'node:path'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 200_000

export const parameters = z.object({
  command: z.string().min(1).describe('Shell command to execute. Run through the OS default shell.'),
  cwd: z
    .string()
    .optional()
    .describe('Optional working directory (absolute or relative). Must resolve under an allowlisted root.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .default(DEFAULT_TIMEOUT_MS)
    .describe('Time before SIGKILL. Default 30s. Maximum 10m.'),
})

/**
 * Roots a shell `cwd` is allowed to resolve under. Configurable via the
 * `SHELL_ALLOWED_CWD_ROOTS` env var (path-separator–delimited like PATH).
 * Defaults to the process cwd and `STORAGE_ROOT` if set.
 */
function allowedCwdRoots(): string[] {
  const fromEnv = process.env.SHELL_ALLOWED_CWD_ROOTS
  if (fromEnv && fromEnv.trim().length > 0) {
    const sep = process.platform === 'win32' ? ';' : ':'
    return fromEnv.split(sep).map((p) => resolve(p)).filter((p) => p.length > 0)
  }
  const roots = [resolve(process.cwd())]
  if (process.env.STORAGE_ROOT) roots.push(resolve(process.env.STORAGE_ROOT))
  return roots
}

function resolveCwd(supplied: string | undefined): { ok: true; cwd: string } | { ok: false; error: string } {
  const roots = allowedCwdRoots()
  if (!supplied) {
    return { ok: true, cwd: roots[0]! }
  }
  const candidate = isAbsolute(supplied) ? resolve(supplied) : resolve(roots[0]!, supplied)
  for (const root of roots) {
    const rel = relative(root, candidate)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return { ok: true, cwd: candidate }
    }
  }
  return {
    ok: false,
    error:
      `cwd "${supplied}" resolves to "${candidate}", which is outside the ` +
      `allowed roots: ${roots.join(', ')}. Set SHELL_ALLOWED_CWD_ROOTS to widen.`,
  }
}

/**
 * Best-effort process-tree kill. Killing the shell parent does NOT
 * propagate to children spawned by the command — especially on Windows,
 * where the shell layer often leaves grandchildren behind. We try the OS
 * tools for tearing down the whole tree first, then fall back to SIGKILL
 * on the parent.
 */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    // /T = tree, /F = force. Detached so we don't await it.
    exec(`taskkill /pid ${pid} /T /F`, () => {
      /* best effort */
    })
    return
  }
  try {
    // Negative pid = "kill the process group". Requires the child to have
    // been spawned with `detached: true` so it gets its own group.
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Group kill failed (e.g. detached: false). Fall back to single kill.
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* nothing more to do */
    }
  }
}

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const cwdResult = resolveCwd(args.cwd)
  if (!cwdResult.ok) {
    return fail('PERMISSION_DENIED', cwdResult.error, false)
  }

  return new Promise((resolve) => {
    const start = Date.now()
    const child = spawn(args.command, {
      shell: true,
      cwd: cwdResult.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: detached creates a new process group so we can kill the
      // tree on timeout. Windows ignores this flag; taskkill handles trees.
      detached: process.platform !== 'win32',
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncatedStdout = false
    let truncatedStderr = false

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) {
        truncatedStdout = true
        return
      }
      const remaining = MAX_OUTPUT_BYTES - stdoutBytes
      if (chunk.byteLength > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining))
        stdoutBytes += remaining
        truncatedStdout = true
      } else {
        stdoutChunks.push(chunk)
        stdoutBytes += chunk.byteLength
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) {
        truncatedStderr = true
        return
      }
      const remaining = MAX_OUTPUT_BYTES - stderrBytes
      if (chunk.byteLength > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining))
        stderrBytes += remaining
        truncatedStderr = true
      } else {
        stderrChunks.push(chunk)
        stderrBytes += chunk.byteLength
      }
    })

    let timedOut = false
    let cancelled = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) killProcessTree(child.pid)
    }, args.timeout_ms)

    const onAbort = (): void => {
      cancelled = true
      if (child.pid !== undefined) killProcessTree(child.pid)
    }
    if (ctx?.signal) {
      if (ctx.signal.aborted) onAbort()
      else ctx.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      if (ctx?.signal) ctx.signal.removeEventListener('abort', onAbort)
      resolve(fail('TOOL_RUNTIME', `Spawn failed: ${err.message}`, false))
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (ctx?.signal) ctx.signal.removeEventListener('abort', onAbort)
      const durationMs = Date.now() - start
      const stdout =
        Buffer.concat(stdoutChunks).toString('utf-8') +
        (truncatedStdout ? '\n[... stdout truncated ...]' : '')
      const stderr =
        Buffer.concat(stderrChunks).toString('utf-8') +
        (truncatedStderr ? '\n[... stderr truncated ...]' : '')

      if (cancelled && !timedOut) {
        resolve(
          fail('TOOL_RUNTIME', 'Command cancelled', false, {
            stdout,
            stderr,
            durationMs,
          }),
        )
        return
      }
      if (timedOut) {
        resolve(
          fail('TOOL_TIMEOUT', `Command timed out after ${args.timeout_ms}ms`, false, {
            stdout,
            stderr,
            durationMs,
          }),
        )
        return
      }
      resolve(
        ok({
          exit_code: code,
          signal,
          stdout,
          stderr,
          duration_ms: durationMs,
        }),
      )
    })
  })
}

export default { parameters, handler }

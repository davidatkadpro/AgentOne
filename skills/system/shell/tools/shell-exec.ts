import { z } from 'zod'
import { spawn } from 'node:child_process'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 200_000

export const parameters = z.object({
  command: z.string().min(1).describe('Shell command to execute. Run through the OS default shell.'),
  cwd: z
    .string()
    .optional()
    .describe('Optional working directory (absolute path or path relative to project root).'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .default(DEFAULT_TIMEOUT_MS)
    .describe('Time before SIGKILL. Default 30s. Maximum 10m.'),
})

export const handler: ToolHandler<typeof parameters> = async (args) => {
  return new Promise((resolve) => {
    const start = Date.now()
    const child = spawn(args.command, {
      shell: true,
      cwd: args.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Track byte counts (not JS string lengths) so multi-byte UTF-8 output
    // doesn't blow past the cap silently.
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
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, args.timeout_ms)

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve(fail('TOOL_RUNTIME', `Spawn failed: ${err.message}`, false))
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const durationMs = Date.now() - start
      const stdout =
        Buffer.concat(stdoutChunks).toString('utf-8') +
        (truncatedStdout ? '\n[... stdout truncated ...]' : '')
      const stderr =
        Buffer.concat(stderrChunks).toString('utf-8') +
        (truncatedStderr ? '\n[... stderr truncated ...]' : '')

      if (timedOut) {
        resolve(
          fail(
            'TOOL_TIMEOUT',
            `Command timed out after ${args.timeout_ms}ms`,
            false,
            { stdout, stderr, durationMs },
          ),
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

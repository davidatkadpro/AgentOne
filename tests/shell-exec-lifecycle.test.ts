import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlerCtx = {
  sessionId: 's',
  agentProfile: 'test',
  services: {} as never,
  permissions: {} as never,
  expertSpend: {} as never,
}

describe('shell_exec — cwd allowlist', () => {
  const originalEnv = { ...process.env }
  let allowed: string
  let forbidden: string

  beforeEach(() => {
    allowed = mkdtempSync(join(tmpdir(), 'agentone-shell-allowed-'))
    forbidden = mkdtempSync(join(tmpdir(), 'agentone-shell-forbidden-'))
    process.env.SHELL_ALLOWED_CWD_ROOTS = allowed
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    try { rmSync(allowed, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(forbidden, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('rejects an absolute cwd outside the allowlist as PERMISSION_DENIED', async () => {
    const { handler } = await import('../skills/system/shell/tools/shell-exec.js')
    const result = await handler(
      { command: 'echo hi', cwd: forbidden, timeout_ms: 5_000 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED')
  })

  it('rejects a relative cwd that escapes the allowlist', async () => {
    const { handler } = await import('../skills/system/shell/tools/shell-exec.js')
    const result = await handler(
      { command: 'echo hi', cwd: '../../../etc', timeout_ms: 5_000 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED')
  })

  it('accepts a cwd inside the allowlist', async () => {
    const { handler } = await import('../skills/system/shell/tools/shell-exec.js')
    const cmd = process.platform === 'win32' ? 'cmd /c echo ok' : 'echo ok'
    const result = await handler(
      { command: cmd, cwd: allowed, timeout_ms: 10_000 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as { stdout: string }
      expect(value.stdout).toContain('ok')
    }
  })

  it('falls back to process.cwd() when cwd is omitted', async () => {
    const { handler } = await import('../skills/system/shell/tools/shell-exec.js')
    // process.cwd() is always in the default allowlist.
    delete process.env.SHELL_ALLOWED_CWD_ROOTS
    const cmd = process.platform === 'win32' ? 'cmd /c echo home' : 'echo home'
    const result = await handler(
      { command: cmd, timeout_ms: 10_000 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(true)
  })
})

describe('shell_exec — cancellation + timeout', () => {
  it('reports TOOL_TIMEOUT when the command exceeds timeout_ms', async () => {
    const { handler } = await import('../skills/system/shell/tools/shell-exec.js')
    const cmd =
      process.platform === 'win32'
        ? 'cmd /c ping 127.0.0.1 -n 10 >nul'
        : 'sleep 5'
    const result = await handler(
      { command: cmd, timeout_ms: 200 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('TOOL_TIMEOUT')
  }, 10_000)

  it('honours ctx.signal abort and reports TOOL_RUNTIME with "cancelled"', async () => {
    const { handler } = await import('../skills/system/shell/tools/shell-exec.js')
    const cmd =
      process.platform === 'win32'
        ? 'cmd /c ping 127.0.0.1 -n 10 >nul'
        : 'sleep 5'
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const result = await handler(
      { command: cmd, timeout_ms: 30_000 },
      { ...handlerCtx, signal: controller.signal } as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/cancelled/i)
  }, 10_000)
})

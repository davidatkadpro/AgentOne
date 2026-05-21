import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAuditLogHook } from '@/skills/audit-log-hook.js'
import { ok, fail } from '@/skills/tool.js'

describe('audit-log hook', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentone-audit-'))
    path = join(dir, 'nested', 'audit.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates parent directories on first write and appends one JSONL record per call', async () => {
    let t = 1700000000_000
    const hook = buildAuditLogHook({ path, now: () => t++ })

    await hook.fn(ok({ data: 'x' }), {
      sessionId: 's1',
      agentProfile: 'p',
      toolId: 'echo',
      toolSource: 'system/filesystem',
      args: { x: 'secret-value' },
    })
    await hook.fn(fail('TOOL_RUNTIME', 'kaboom'), {
      sessionId: 's2',
      agentProfile: 'p',
      toolId: 'glob',
      toolSource: 'system/filesystem',
      args: { prefix: 'wiki' },
    })

    const text = await readFile(path, 'utf-8')
    const lines = text.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)

    const a = JSON.parse(lines[0]!)
    expect(a).toEqual({
      ts: 1700000000_000,
      sessionId: 's1',
      agentProfile: 'p',
      tool: 'echo',
      source: 'system/filesystem',
      argsSummary: ['x'],
      ok: true,
    })

    const b = JSON.parse(lines[1]!)
    expect(b).toMatchObject({
      ts: 1700000000_001,
      sessionId: 's2',
      tool: 'glob',
      ok: false,
      errorCode: 'TOOL_RUNTIME',
      errorMessage: 'kaboom',
    })
  })

  it('default redactor returns only the arg keys, not values', async () => {
    const hook = buildAuditLogHook({ path })
    await hook.fn(ok({}), {
      sessionId: 's',
      agentProfile: 'p',
      toolId: 't',
      toolSource: 'core',
      args: { username: 'alice', password: 'hunter2' },
    })
    const text = await readFile(path, 'utf-8')
    const rec = JSON.parse(text.trim())
    expect(rec.argsSummary).toEqual(['username', 'password'])
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('alice')
  })

  it('honours a custom redactor', async () => {
    const hook = buildAuditLogHook({
      path,
      redactArgs: (a) => ({ ...(a as object), password: '[redacted]' }),
    })
    await hook.fn(ok({}), {
      sessionId: 's',
      agentProfile: 'p',
      toolId: 't',
      toolSource: 'core',
      args: { username: 'alice', password: 'hunter2' },
    })
    const text = await readFile(path, 'utf-8')
    const rec = JSON.parse(text.trim())
    expect(rec.argsSummary).toEqual({ username: 'alice', password: '[redacted]' })
    expect(text).not.toContain('hunter2')
  })

  it('always returns transform=pass — never mutates the result', async () => {
    const hook = buildAuditLogHook({ path })
    const result = ok({ untouched: true })
    const r = await hook.fn(result, {
      sessionId: 's',
      agentProfile: 'p',
      toolId: 't',
      toolSource: 'core',
      args: {},
    })
    expect(r).toEqual({ transform: 'pass' })
  })
})

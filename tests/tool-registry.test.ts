import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '@/skills/registry.js'
import type { ToolContext, ToolHandler } from '@/skills/tool.js'

function fakeCtx(): ToolContext {
  return {
    sessionId: 's1',
    agentProfile: 'test',
    services: {
      storage: {} as never,
      wiki: {} as never,
    },
  }
}

function register(reg: ToolRegistry, id: string, handler: ToolHandler<typeof PSchema>) {
  reg.register({
    id,
    description: id,
    parameters: PSchema,
    handler: handler as ToolHandler,
    source: 'test',
  })
}

const PSchema = z.object({
  n: z.number().int(),
})

describe('ToolRegistry', () => {
  it('register + has + list', () => {
    const reg = new ToolRegistry()
    register(reg, 'add', async (args) => ({ ok: true, value: args.n + 1 }))
    expect(reg.has('add')).toBe(true)
    expect(reg.list()).toHaveLength(1)
  })

  it('throws on duplicate registration', () => {
    const reg = new ToolRegistry()
    register(reg, 'add', async () => ({ ok: true, value: null }))
    expect(() => register(reg, 'add', async () => ({ ok: true, value: null }))).toThrow()
  })

  it('execute returns TOOL_VALIDATION for unknown tool', async () => {
    const reg = new ToolRegistry()
    const result = await reg.execute('nope', '{}', fakeCtx())
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) {
      expect(result.result.error.code).toBe('TOOL_VALIDATION')
    }
  })

  it('execute returns TOOL_VALIDATION for non-JSON args', async () => {
    const reg = new ToolRegistry()
    register(reg, 'add', async () => ({ ok: true, value: null }))
    const result = await reg.execute('add', '{not-json', fakeCtx())
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) {
      expect(result.result.error.code).toBe('TOOL_VALIDATION')
    }
  })

  it('execute returns TOOL_VALIDATION when args fail schema', async () => {
    const reg = new ToolRegistry()
    register(reg, 'add', async () => ({ ok: true, value: null }))
    const result = await reg.execute('add', '{"n": "not-a-number"}', fakeCtx())
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) {
      expect(result.result.error.code).toBe('TOOL_VALIDATION')
      expect(result.result.error.recoverable).toBe(true)
    }
  })

  it('execute returns the handler value on success', async () => {
    const reg = new ToolRegistry()
    register(reg, 'add', async (args) => ({ ok: true, value: args.n + 1 }))
    const result = await reg.execute('add', '{"n": 41}', fakeCtx())
    expect(result.result.ok).toBe(true)
    if (result.result.ok) {
      expect(result.result.value).toBe(42)
    }
  })

  it('execute wraps thrown errors as TOOL_RUNTIME', async () => {
    const reg = new ToolRegistry()
    register(reg, 'boom', async () => {
      throw new Error('handler exploded')
    })
    const result = await reg.execute('boom', '{"n": 1}', fakeCtx())
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) {
      expect(result.result.error.code).toBe('TOOL_RUNTIME')
      expect(result.result.error.message).toContain('handler exploded')
    }
  })

  it('execute enforces per-tool timeout', async () => {
    const reg = new ToolRegistry()
    reg.register({
      id: 'slow',
      description: 'slow',
      parameters: PSchema,
      handler: (async () => {
        await new Promise((r) => setTimeout(r, 100))
        return { ok: true, value: null }
      }) as ToolHandler,
      source: 'test',
      timeoutMs: 20,
    })
    const result = await reg.execute('slow', '{"n": 1}', fakeCtx())
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) {
      expect(result.result.error.code).toBe('TOOL_TIMEOUT')
    }
  })

  it('execute reports duration', async () => {
    const reg = new ToolRegistry()
    register(reg, 'fast', async () => ({ ok: true, value: null }))
    const result = await reg.execute('fast', '{"n": 1}', fakeCtx())
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('toolDefinitions returns OpenAI-style entries with JSON Schema', () => {
    const reg = new ToolRegistry()
    register(reg, 'add', async () => ({ ok: true, value: null }))
    const defs = reg.toolDefinitions()
    expect(defs).toHaveLength(1)
    expect(defs[0]?.type).toBe('function')
    expect(defs[0]?.function.name).toBe('add')
    const schema = defs[0]?.function.parameters as Record<string, unknown>
    expect(schema.type).toBe('object')
    const props = schema.properties as Record<string, unknown>
    expect((props.n as { type: string }).type).toBe('number')
  })
})

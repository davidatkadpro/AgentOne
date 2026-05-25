import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '@/skills/registry.js'
import type { ToolHandler } from '@/skills/tool.js'
import { fakeToolContext } from './fakes.js'

const fakeCtx = (): ReturnType<typeof fakeToolContext> => fakeToolContext()

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

  it('execute retries via unknown-tool resolver and runs the lazily-registered handler', async () => {
    const reg = new ToolRegistry()
    let resolverCalls = 0
    reg.setUnknownToolResolver(async (id) => {
      resolverCalls++
      if (id !== 'lazy') return false
      register(reg, 'lazy', async (args) => ({ ok: true, value: args.n * 2 }))
      return true
    })
    const result = await reg.execute('lazy', '{"n": 21}', fakeCtx())
    expect(resolverCalls).toBe(1)
    expect(result.result.ok).toBe(true)
    if (result.result.ok) {
      expect(result.result.value).toBe(42)
    }
  })

  it('execute still returns TOOL_VALIDATION when the resolver declines', async () => {
    const reg = new ToolRegistry()
    reg.setUnknownToolResolver(async () => false)
    const result = await reg.execute('nope', '{}', fakeCtx())
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) {
      expect(result.result.error.code).toBe('TOOL_VALIDATION')
    }
  })

  it('execute swallows resolver throws and reports TOOL_VALIDATION', async () => {
    const reg = new ToolRegistry()
    reg.setUnknownToolResolver(async () => {
      throw new Error('resolver exploded')
    })
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

  it('execute aborts the handler signal on timeout', async () => {
    const reg = new ToolRegistry()
    let observedAborted: boolean | undefined
    reg.register({
      id: 'slow-abortable',
      description: 'slow-abortable',
      parameters: PSchema,
      handler: (async (_args, ctx) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 200)
          ctx.signal?.addEventListener('abort', () => {
            clearTimeout(t)
            resolve()
          })
        })
        observedAborted = ctx.signal?.aborted
        return { ok: true, value: 'handler finished after abort' }
      }) as ToolHandler,
      source: 'test',
      timeoutMs: 25,
    })
    const result = await reg.execute('slow-abortable', '{"n": 1}', fakeCtx())
    // Timeout still reported to caller.
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) expect(result.result.error.code).toBe('TOOL_TIMEOUT')
    // Give the handler a tick to observe the abort and resolve.
    await new Promise((r) => setTimeout(r, 50))
    expect(observedAborted).toBe(true)
  })

  it('execute forwards an upstream signal to handler.ctx.signal', async () => {
    const reg = new ToolRegistry()
    let handlerSignal: AbortSignal | undefined
    reg.register({
      id: 'observe',
      description: 'observe',
      parameters: PSchema,
      handler: (async (_args, ctx) => {
        handlerSignal = ctx.signal
        return { ok: true, value: null }
      }) as ToolHandler,
      source: 'test',
    })
    const upstream = new AbortController()
    const ctx = { ...fakeCtx(), signal: upstream.signal }
    await reg.execute('observe', '{"n": 1}', ctx)
    expect(handlerSignal).toBeInstanceOf(AbortSignal)
    // Aborting the upstream cascades to the handler signal — verify the
    // listener wiring works by aborting *during* a slower handler.
  })

  it('upstream abort cascades into the handler signal', async () => {
    const reg = new ToolRegistry()
    let observedAborted = false
    reg.register({
      id: 'wait-for-abort',
      description: 'wait-for-abort',
      parameters: PSchema,
      handler: (async (_args, ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            observedAborted = true
            resolve()
          })
        })
        return { ok: true, value: null }
      }) as ToolHandler,
      source: 'test',
      timeoutMs: 5_000,
    })
    const upstream = new AbortController()
    const ctx = { ...fakeCtx(), signal: upstream.signal }
    const exec = reg.execute('wait-for-abort', '{"n": 1}', ctx)
    setTimeout(() => upstream.abort(), 10)
    await exec
    expect(observedAborted).toBe(true)
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

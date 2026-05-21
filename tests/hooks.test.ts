import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { HookRegistry, type PreToolHook, type PostToolHook } from '@/skills/hooks.js'
import { ToolRegistry } from '@/skills/registry.js'
import type { ToolHandler, ToolResult } from '@/skills/tool.js'
import { ok, fail } from '@/skills/tool.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import { fakeToolContext } from './fakes.js'

const fakeCtx = (): ReturnType<typeof fakeToolContext> =>
  fakeToolContext({ sessionId: 'sess-1' })

const PSchema = z.object({ x: z.string() })

function registerEcho(reg: ToolRegistry): void {
  const handler: ToolHandler<typeof PSchema> = (args) => ok({ echoed: args.x })
  reg.register({
    id: 'echo',
    description: 'echo x',
    parameters: PSchema,
    handler: handler as ToolHandler,
    source: 'test',
  })
}

describe('HookRegistry pre-chain', () => {
  it('returns allow with the original args when there are no hooks', async () => {
    const r = new HookRegistry()
    const outcome = await r.runPre({ x: 'a' }, ctxBase())
    expect(outcome).toEqual({ kind: 'allow', args: { x: 'a' } })
  })

  it('threads mutated args through the chain in registration order', async () => {
    const r = new HookRegistry()
    r.addPreHook(mutator('A', (a) => ({ ...(a as object), step1: true })))
    r.addPreHook(mutator('B', (a) => ({ ...(a as object), step2: true })))
    const outcome = await r.runPre({ x: 'a' }, ctxBase())
    expect(outcome).toEqual({
      kind: 'allow',
      args: { x: 'a', step1: true, step2: true },
    })
  })

  it('first deny short-circuits the chain', async () => {
    const r = new HookRegistry()
    let bCalled = false
    r.addPreHook({
      name: 'A',
      fn: () => ({ decision: 'deny', reason: 'because' }),
    })
    r.addPreHook({
      name: 'B',
      fn: () => {
        bCalled = true
        return { decision: 'allow' }
      },
    })
    const outcome = await r.runPre({}, ctxBase())
    expect(outcome.kind).toBe('deny')
    if (outcome.kind === 'deny') {
      expect(outcome.byHook).toBe('A')
      expect(outcome.reason).toBe('because')
    }
    expect(bCalled).toBe(false)
  })

  it('first mock short-circuits and surfaces the mocked result', async () => {
    const r = new HookRegistry()
    const mockedResult: ToolResult = ok({ from: 'mock' })
    r.addPreHook({
      name: 'M',
      fn: () => ({ decision: 'mock', result: mockedResult }),
    })
    r.addPreHook({
      name: 'After',
      fn: () => {
        throw new Error('should not run')
      },
    })
    const outcome = await r.runPre({}, ctxBase())
    expect(outcome.kind).toBe('mock')
    if (outcome.kind === 'mock') {
      expect(outcome.byHook).toBe('M')
      expect(outcome.result).toBe(mockedResult)
    }
  })

  it('exposes the current args to each hook via ctx', async () => {
    const r = new HookRegistry()
    r.addPreHook(mutator('A', (a) => ({ ...(a as object), one: 1 })))
    let seenByB: unknown
    r.addPreHook({
      name: 'B',
      fn: (args, ctx) => {
        seenByB = ctx.args
        expect(args).toEqual(ctx.args)
        return { decision: 'allow' }
      },
    })
    await r.runPre({ x: 'a' }, ctxBase())
    expect(seenByB).toEqual({ x: 'a', one: 1 })
  })
})

describe('HookRegistry post-chain', () => {
  it('returns the original result when there are no hooks', async () => {
    const r = new HookRegistry()
    const out = await r.runPost(ok({ a: 1 }), { ...ctxBase(), args: {} })
    expect(out).toEqual({ ok: true, value: { a: 1 } })
  })

  it('chains replacements — each hook sees the previous hook\'s output', async () => {
    const r = new HookRegistry()
    r.addPostHook({
      name: 'wrap',
      fn: (result) => ({
        transform: 'replace',
        result: result.ok ? ok({ wrapped: result.value }) : result,
      }),
    })
    r.addPostHook({
      name: 'tag',
      fn: (result) => ({
        transform: 'replace',
        result: result.ok ? ok({ ...(result.value as object), seenByTag: true }) : result,
      }),
    })
    const out = await r.runPost(ok({ raw: 1 }), { ...ctxBase(), args: {} })
    expect(out).toEqual({
      ok: true,
      value: { wrapped: { raw: 1 }, seenByTag: true },
    })
  })

  it('runs every post-hook (no short-circuit on errors)', async () => {
    const r = new HookRegistry()
    const calls: string[] = []
    r.addPostHook({
      name: 'a',
      fn: () => {
        calls.push('a')
        return { transform: 'pass' }
      },
    })
    r.addPostHook({
      name: 'b',
      fn: () => {
        calls.push('b')
        return { transform: 'pass' }
      },
    })
    await r.runPost(fail('TOOL_RUNTIME', 'kaboom'), { ...ctxBase(), args: {} })
    expect(calls).toEqual(['a', 'b'])
  })
})

describe('ToolRegistry.execute hook integration', () => {
  it('runs without hooks when no HookRegistry is provided', async () => {
    const reg = new ToolRegistry()
    registerEcho(reg)
    const { result } = await reg.execute('echo', '{"x":"hi"}', fakeCtx())
    expect(result).toEqual({ ok: true, value: { echoed: 'hi' } })
  })

  it('lets a pre-hook mutate the args before the handler sees them', async () => {
    const hooks = new HookRegistry()
    hooks.addPreHook(mutator('upper', (a) => ({ x: (a as { x: string }).x.toUpperCase() })))
    const reg = new ToolRegistry(hooks)
    registerEcho(reg)
    const { result } = await reg.execute('echo', '{"x":"hi"}', fakeCtx())
    expect(result).toEqual({ ok: true, value: { echoed: 'HI' } })
  })

  it('translates a pre-hook deny into PERMISSION_DENIED + emits tool.hook_denied', async () => {
    const bus = new EventBus()
    const events: AgentEvent[] = []
    bus.onAny((e) => {
      events.push(e)
    })
    const hooks = new HookRegistry()
    hooks.addPreHook({ name: 'no-echo', fn: () => ({ decision: 'deny', reason: 'forbidden' }) })
    const reg = new ToolRegistry(hooks, bus)
    registerEcho(reg)
    const { result } = await reg.execute('echo', '{"x":"hi"}', fakeCtx())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('PERMISSION_DENIED')
    expect(result.error.message).toMatch(/no-echo/)
    const denied = events.find((e) => e.type === 'tool.hook_denied')
    expect(denied).toMatchObject({ tool: 'echo', hook: 'no-echo', reason: 'forbidden' })
  })

  it('uses the mocked result and skips the handler + emits tool.hook_mocked', async () => {
    const bus = new EventBus()
    const events: AgentEvent[] = []
    bus.onAny((e) => {
      events.push(e)
    })
    const hooks = new HookRegistry()
    hooks.addPreHook({
      name: 'mock-echo',
      fn: () => ({ decision: 'mock', result: ok({ echoed: 'MOCKED' }) }),
    })
    const reg = new ToolRegistry(hooks, bus)
    let handlerCalled = false
    reg.register({
      id: 'echo',
      description: 'echo',
      parameters: PSchema,
      handler: (() => {
        handlerCalled = true
        return ok({ echoed: 'real' })
      }) as ToolHandler,
      source: 'test',
    })
    const { result } = await reg.execute('echo', '{"x":"hi"}', fakeCtx())
    expect(handlerCalled).toBe(false)
    expect(result).toEqual({ ok: true, value: { echoed: 'MOCKED' } })
    expect(events.find((e) => e.type === 'tool.hook_mocked')).toMatchObject({
      tool: 'echo',
      hook: 'mock-echo',
    })
  })

  it('lets a post-hook replace the result', async () => {
    const hooks = new HookRegistry()
    hooks.addPostHook({
      name: 'rewrite',
      fn: (result) => ({
        transform: 'replace',
        result: result.ok ? ok({ rewrote: true }) : result,
      }),
    })
    const reg = new ToolRegistry(hooks)
    registerEcho(reg)
    const { result } = await reg.execute('echo', '{"x":"hi"}', fakeCtx())
    expect(result).toEqual({ ok: true, value: { rewrote: true } })
  })

  it('runs post-hooks even when the handler failed', async () => {
    const seen: ToolResult[] = []
    const hooks = new HookRegistry()
    hooks.addPostHook({
      name: 'capture',
      fn: (result) => {
        seen.push(result)
        return { transform: 'pass' }
      },
    })
    const reg = new ToolRegistry(hooks)
    reg.register({
      id: 'echo',
      description: 'echo',
      parameters: PSchema,
      handler: (() => fail('TOOL_RUNTIME', 'kaboom')) as ToolHandler,
      source: 'test',
    })
    await reg.execute('echo', '{"x":"hi"}', fakeCtx())
    expect(seen).toHaveLength(1)
    expect(seen[0]!.ok).toBe(false)
  })

  it('fails closed on pre-hook crash — handler does not run', async () => {
    let handlerCalled = false
    const hooks = new HookRegistry()
    hooks.addPreHook({
      name: 'crasher',
      fn: () => {
        throw new Error('pre crashed')
      },
    })
    const reg = new ToolRegistry(hooks)
    reg.register({
      id: 'echo',
      description: 'echo',
      parameters: PSchema,
      handler: (() => {
        handlerCalled = true
        return ok({})
      }) as ToolHandler,
      source: 'test',
    })
    const { result } = await reg.execute('echo', '{"x":"hi"}', fakeCtx())
    expect(handlerCalled).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('TOOL_RUNTIME')
    expect(result.error.message).toMatch(/pre crashed/i)
  })

  it('fails closed on post-hook crash even when the handler succeeded', async () => {
    const hooks = new HookRegistry()
    hooks.addPostHook({
      name: 'crasher',
      fn: () => {
        throw new Error('post crashed')
      },
    })
    const reg = new ToolRegistry(hooks)
    registerEcho(reg)
    const { result } = await reg.execute('echo', '{"x":"hi"}', fakeCtx())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('TOOL_RUNTIME')
    expect(result.error.message).toMatch(/post crashed/i)
  })

  it('does NOT run pre-hooks when args fail Zod validation', async () => {
    let preCalled = false
    const hooks = new HookRegistry()
    hooks.addPreHook({
      name: 'observer',
      fn: () => {
        preCalled = true
        return { decision: 'allow' }
      },
    })
    const reg = new ToolRegistry(hooks)
    registerEcho(reg)
    // Missing required `x` field.
    const { result } = await reg.execute('echo', '{}', fakeCtx())
    expect(preCalled).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('TOOL_VALIDATION')
  })

  it('post-hook ctx.args is the args the handler actually received (after pre-hook mutation)', async () => {
    let postArgs: unknown
    const hooks = new HookRegistry()
    hooks.addPreHook(mutator('upper', (a) => ({ x: (a as { x: string }).x.toUpperCase() })))
    hooks.addPostHook({
      name: 'capture-args',
      fn: (_r, ctx) => {
        postArgs = ctx.args
        return { transform: 'pass' }
      },
    })
    const reg = new ToolRegistry(hooks)
    registerEcho(reg)
    await reg.execute('echo', '{"x":"hi"}', fakeCtx())
    expect(postArgs).toEqual({ x: 'HI' })
  })
})

// ---------- helpers ----------

function ctxBase(): Omit<import('@/skills/hooks.js').ToolHookContext, 'args'> {
  return {
    sessionId: 's1',
    agentProfile: 'p',
    toolId: 'echo',
    toolSource: 'test',
  }
}

function mutator(name: string, transform: (a: unknown) => unknown): PreToolHook {
  return {
    name,
    fn: (args) => ({ decision: 'allow', args: transform(args) }),
  }
}

// satisfy unused-import lint on PostToolHook (kept for the type re-export)
void {} as PostToolHook | undefined

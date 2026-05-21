import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EventHookRunner,
  loadEventHooks,
  type EventHookHandler,
} from '@/hooks/event-hook-runner.js'
import { EventBus, type AgentEvent } from '@/core/events.js'

function userEvent(): AgentEvent {
  return {
    type: 'message.user.received',
    sessionId: 's1',
    turnId: 't1',
    ts: 0,
  }
}

function completedEvent(): AgentEvent {
  return {
    type: 'message.assistant.completed',
    sessionId: 's1',
    turnId: 't1',
    inputTokens: 1,
    outputTokens: 1,
    ts: 0,
  }
}

describe('EventHookRunner.dispatch', () => {
  it('fires hooks whose `on` matches the event type', () => {
    const called: string[] = []
    const handler: EventHookHandler = (e) => {
      called.push(e.type)
    }
    const runner = new EventHookRunner({
      hooks: [{ on: 'message.user.received', handler, source: 'test' }],
    })
    runner.dispatch(userEvent())
    runner.dispatch(completedEvent())
    expect(called).toEqual(['message.user.received'])
  })

  it('fires `*` hooks for every event', () => {
    const called: string[] = []
    const handler: EventHookHandler = (e) => {
      called.push(e.type)
    }
    const runner = new EventHookRunner({
      hooks: [{ on: '*', handler, source: 'all' }],
    })
    runner.dispatch(userEvent())
    runner.dispatch(completedEvent())
    expect(called).toEqual(['message.user.received', 'message.assistant.completed'])
  })

  it('runs all matching hooks for one event', () => {
    const order: string[] = []
    const a: EventHookHandler = () => void order.push('a')
    const b: EventHookHandler = () => void order.push('b')
    const runner = new EventHookRunner({
      hooks: [
        { on: 'message.user.received', handler: a, source: 'a' },
        { on: '*', handler: b, source: 'b' },
      ],
    })
    runner.dispatch(userEvent())
    expect(order).toEqual(['a', 'b'])
  })

  it('isolates errors thrown by a handler', () => {
    const errors: Array<{ source: string; msg: string }> = []
    const runner = new EventHookRunner({
      hooks: [
        {
          on: '*',
          handler: () => {
            throw new Error('boom')
          },
          source: 'crashy',
        },
      ],
      onHandlerError: (hook, err) => {
        errors.push({
          source: hook.source,
          msg: err instanceof Error ? err.message : String(err),
        })
      },
    })
    runner.dispatch(userEvent())
    expect(errors).toEqual([{ source: 'crashy', msg: 'boom' }])
  })

  it('isolates rejected promises from async handlers', async () => {
    const errors: string[] = []
    const runner = new EventHookRunner({
      hooks: [
        {
          on: '*',
          handler: async () => {
            throw new Error('async-boom')
          },
          source: 'crashy',
        },
      ],
      onHandlerError: (_h, err) => {
        errors.push(err instanceof Error ? err.message : String(err))
      },
    })
    runner.dispatch(userEvent())
    // Promise rejection handling is microtask-deferred.
    await new Promise((r) => setImmediate(r))
    expect(errors).toEqual(['async-boom'])
  })
})

describe('EventHookRunner.start', () => {
  it('subscribes to the bus and fires for matching events', async () => {
    const calls: string[] = []
    const bus = new EventBus()
    const runner = new EventHookRunner({
      hooks: [{ on: '*', handler: (e) => void calls.push(e.type), source: 'test' }],
    })
    runner.start(bus)
    await bus.emit(userEvent())
    expect(calls).toEqual(['message.user.received'])
    runner.stop()
    await bus.emit(userEvent())
    // After stop(), no further events are received.
    expect(calls).toEqual(['message.user.received'])
  })
})

describe('loadEventHooks', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentone-hooks-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when the config file does not exist', async () => {
    const runner = await loadEventHooks(join(dir, 'missing.yaml'))
    expect(runner).toBeNull()
  })

  it('loads a hook from disk and dispatches against it', async () => {
    const handlerPath = join(dir, 'log-handler.mjs')
    await writeFile(
      handlerPath,
      `
      let calls = []
      export default async function(event) {
        calls.push(event.type)
        globalThis.__hookCalls = calls
      }
      `,
      'utf-8',
    )
    const cfgPath = join(dir, 'hooks.yaml')
    await writeFile(
      cfgPath,
      `- on: 'message.user.received'\n  handler: './log-handler.mjs'\n`,
      'utf-8',
    )
    const runner = await loadEventHooks(cfgPath)
    expect(runner).not.toBeNull()
    expect(runner!.hookCount()).toBe(1)
    runner!.dispatch(userEvent())
    await new Promise((r) => setImmediate(r))
    expect((globalThis as unknown as { __hookCalls: string[] }).__hookCalls).toEqual([
      'message.user.received',
    ])
  })

  it('rejects a hook YAML with the wrong shape', async () => {
    const cfgPath = join(dir, 'hooks.yaml')
    await writeFile(cfgPath, `- bad: 'shape'\n`, 'utf-8')
    await expect(loadEventHooks(cfgPath)).rejects.toThrow(/Invalid event hooks/)
  })

  it('rejects a hook whose handler module has no default export', async () => {
    const handlerPath = join(dir, 'no-default.mjs')
    await writeFile(handlerPath, `export function notDefault() {}\n`, 'utf-8')
    const cfgPath = join(dir, 'hooks.yaml')
    await writeFile(
      cfgPath,
      `- on: '*'\n  handler: './no-default.mjs'\n`,
      'utf-8',
    )
    await expect(loadEventHooks(cfgPath)).rejects.toThrow(/no default export/)
  })
})

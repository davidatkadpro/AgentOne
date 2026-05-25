import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/core/events.js'
import { runTurnInBackground } from '../src/server/background-drain.js'

describe('runTurnInBackground', () => {
  it('drains a successful stream silently', async () => {
    const bus = new EventBus()
    const observed: string[] = []
    bus.onAny((e) => {
      observed.push(e.type)
    })

    async function* ok(): AsyncIterable<string> {
      yield 'a'
      yield 'b'
    }
    runTurnInBackground({ bus, log: () => undefined }, 'session-1', ok())
    await new Promise((r) => setTimeout(r, 10))
    expect(observed).not.toContain('turn.failed')
  })

  it('emits turn.failed when the stream rejects', async () => {
    const bus = new EventBus()
    const events: Array<{ type: string }> = []
    bus.onAny((e) => {
      events.push(e)
    })
    const logged: string[] = []

    async function* boom(): AsyncIterable<string> {
      yield 'partial'
      throw new Error('provider exploded mid-stream')
    }

    runTurnInBackground({ bus, log: (m) => logged.push(m) }, 'session-2', boom())
    await new Promise((r) => setTimeout(r, 10))

    const failed = events.find((e) => e.type === 'turn.failed') as
      | { type: 'turn.failed'; sessionId: string; source: string; message: string }
      | undefined
    expect(failed).toBeDefined()
    expect(failed?.sessionId).toBe('session-2')
    expect(failed?.source).toBe('provider')
    expect(failed?.message).toContain('provider exploded')
    expect(logged.some((l) => l.includes('session-2'))).toBe(true)
  })

  it('does not throw or surface unhandled rejections when the stream throws synchronously', async () => {
    const bus = new EventBus()
    const events: Array<{ type: string }> = []
    bus.onAny((e) => {
      events.push(e)
    })

    // A stream that throws on its very first iteration. This is the case
    // that historically would have crashed Node under strict
    // unhandled-rejection settings.
    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new Error('immediate provider failure')),
        }
      },
    }

    // The function returns void synchronously — the failure is reported
    // asynchronously via the bus.
    expect(() =>
      runTurnInBackground({ bus, log: () => undefined }, 'session-3', stream),
    ).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))
    const failed = events.find((e) => e.type === 'turn.failed')
    expect(failed).toBeDefined()
  })
})

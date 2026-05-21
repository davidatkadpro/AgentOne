import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain ES module, no .d.ts
import { nextReconnectDelayMs, disconnectNoticeFor } from '../src/frontend/ws-backoff.js'

describe('nextReconnectDelayMs', () => {
  it('doubles per attempt starting at 1s', () => {
    expect(nextReconnectDelayMs(0)).toBe(1_000)
    expect(nextReconnectDelayMs(1)).toBe(2_000)
    expect(nextReconnectDelayMs(2)).toBe(4_000)
    expect(nextReconnectDelayMs(3)).toBe(8_000)
    expect(nextReconnectDelayMs(4)).toBe(16_000)
  })

  it('caps at 30 seconds', () => {
    expect(nextReconnectDelayMs(5)).toBe(30_000)
    expect(nextReconnectDelayMs(10)).toBe(30_000)
    expect(nextReconnectDelayMs(100)).toBe(30_000)
  })

  it('treats negative attempts as zero', () => {
    expect(nextReconnectDelayMs(-1)).toBe(1_000)
    expect(nextReconnectDelayMs(-100)).toBe(1_000)
  })
})

describe('disconnectNoticeFor', () => {
  it('shows a fresh notice on the first drop (attempt 0)', () => {
    const msg = disconnectNoticeFor(0, 1_000)
    expect(msg).toContain('Disconnected')
    expect(msg).toContain('1s')
  })

  it('returns null for quiet retries between escalations', () => {
    expect(disconnectNoticeFor(1, 2_000)).toBeNull()
    expect(disconnectNoticeFor(2, 4_000)).toBeNull()
    expect(disconnectNoticeFor(3, 8_000)).toBeNull()
    expect(disconnectNoticeFor(4, 16_000)).toBeNull()
  })

  it('escalates every 5 retries', () => {
    const five = disconnectNoticeFor(5, 30_000)
    expect(five).not.toBeNull()
    expect(five).toContain('5 retries')
    expect(disconnectNoticeFor(10, 30_000)).toContain('10 retries')
  })

  it('rounds the delay seconds', () => {
    expect(disconnectNoticeFor(0, 1_500)).toContain('2s') // Math.round(1.5) = 2
    expect(disconnectNoticeFor(0, 1_400)).toContain('1s') // Math.round(1.4) = 1
  })
})

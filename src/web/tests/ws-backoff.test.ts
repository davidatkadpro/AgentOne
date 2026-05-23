import { describe, it, expect } from 'vitest'
import { nextReconnectDelayMs, disconnectNoticeFor } from '@/lib/ws-backoff'

describe('nextReconnectDelayMs', () => {
  it('returns 1s on first attempt', () => {
    expect(nextReconnectDelayMs(0)).toBe(1000)
  })
  it('doubles exponentially', () => {
    expect(nextReconnectDelayMs(1)).toBe(2000)
    expect(nextReconnectDelayMs(2)).toBe(4000)
    expect(nextReconnectDelayMs(3)).toBe(8000)
    expect(nextReconnectDelayMs(4)).toBe(16000)
  })
  it('caps at 30s', () => {
    expect(nextReconnectDelayMs(5)).toBe(30_000)
    expect(nextReconnectDelayMs(99)).toBe(30_000)
  })
  it('clamps negative attempts', () => {
    expect(nextReconnectDelayMs(-1)).toBe(1000)
  })
})

describe('disconnectNoticeFor', () => {
  it('returns a message on first drop', () => {
    expect(disconnectNoticeFor(0, 1000)).toMatch(/Disconnected/)
  })
  it('stays quiet on retries 1-4', () => {
    expect(disconnectNoticeFor(1, 2000)).toBeNull()
    expect(disconnectNoticeFor(4, 16000)).toBeNull()
  })
  it('escalates every 5 retries', () => {
    expect(disconnectNoticeFor(5, 30_000)).toMatch(/Still disconnected/)
    expect(disconnectNoticeFor(10, 30_000)).toMatch(/Still disconnected/)
  })
})

import { describe, it, expect } from 'vitest'
import { recencyBucket, formatRelative, formatDuration } from '@/lib/time'

describe('recencyBucket', () => {
  const NOON = new Date('2026-05-23T12:00:00').getTime()
  it('classifies same-day as today', () => {
    expect(recencyBucket(new Date('2026-05-23T01:00:00').getTime(), NOON)).toBe('today')
  })
  it('classifies last 6 days as week', () => {
    expect(recencyBucket(new Date('2026-05-20T12:00:00').getTime(), NOON)).toBe('week')
  })
  it('classifies older than 6 days as earlier', () => {
    expect(recencyBucket(new Date('2026-05-10T12:00:00').getTime(), NOON)).toBe('earlier')
  })
})

describe('formatRelative', () => {
  const NOW = 1_700_000_000_000
  it('says just now under 60s', () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe('just now')
  })
  it('formats minutes', () => {
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe('5m ago')
  })
  it('formats hours', () => {
    expect(formatRelative(NOW - 3 * 60 * 60_000, NOW)).toBe('3h ago')
  })
  it('formats days', () => {
    expect(formatRelative(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2d ago')
  })
})

describe('formatDuration', () => {
  it('handles ms', () => {
    expect(formatDuration(500)).toBe('500ms')
  })
  it('handles seconds', () => {
    expect(formatDuration(2500)).toBe('2.5s')
  })
  it('handles minutes', () => {
    expect(formatDuration(120_000)).toBe('2m')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAuthToken,
  getAuthToken,
  readTokenFromHash,
  setAuthToken,
} from '@/lib/auth-token'

describe('auth-token storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips set/get/clear', () => {
    expect(getAuthToken()).toBeNull()
    setAuthToken('hello')
    expect(getAuthToken()).toBe('hello')
    clearAuthToken()
    expect(getAuthToken()).toBeNull()
  })

  it('reads ?token= from the URL search and strips it', () => {
    window.history.replaceState(null, '', '/?token=abc123&other=keep')
    const harvested = readTokenFromHash()
    expect(harvested).toBe(true)
    expect(getAuthToken()).toBe('abc123')
    // Token query removed from URL.
    expect(window.location.search).toBe('')
  })

  it('reads #token= from the URL fragment and strips it', () => {
    window.history.replaceState(null, '', '/#token=hash-token')
    const harvested = readTokenFromHash()
    expect(harvested).toBe(true)
    expect(getAuthToken()).toBe('hash-token')
    expect(window.location.hash).toBe('')
  })

  it('prefers fragment over search when both are present', () => {
    window.history.replaceState(null, '', '/?token=search#token=hash')
    readTokenFromHash()
    expect(getAuthToken()).toBe('hash')
  })

  it('does nothing when neither location has a token', () => {
    window.history.replaceState(null, '', '/some/path?keep=1#anchor')
    const harvested = readTokenFromHash()
    expect(harvested).toBe(false)
    expect(getAuthToken()).toBeNull()
    expect(window.location.search).toBe('?keep=1')
    expect(window.location.hash).toBe('#anchor')
  })
})

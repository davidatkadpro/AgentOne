import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `http-request` reads DNS through `dns/promises.lookup`. We stub the module
// before importing the handler so SSRF tests don't make real DNS calls.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'private.example.com') return [{ address: '10.0.0.1', family: 4 }]
    if (host === 'metadata.example.com') return [{ address: '169.254.169.254', family: 4 }]
    return [{ address: '93.184.216.34', family: 4 }]
  }),
}))

const handlerCtx = {
  sessionId: 's',
  agentProfile: 'test',
  services: {} as never,
  permissions: {} as never,
  expertSpend: {} as never,
}

describe('http_request handler — SSRF protection', () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    vi.restoreAllMocks()
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('rejects loopback IPv4 literal as PERMISSION_DENIED without calling fetch', async () => {
    const { handler } = await import('../skills/system/web/tools/http-request.js')
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await handler(
      { url: 'http://127.0.0.1/admin', method: 'GET', timeout_ms: 1_000 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects IPv6 loopback literal as PERMISSION_DENIED', async () => {
    const { handler } = await import('../skills/system/web/tools/http-request.js')
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await handler(
      { url: 'http://[::1]/admin', method: 'GET', timeout_ms: 1_000 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects hostnames resolving to private addresses', async () => {
    const { handler } = await import('../skills/system/web/tools/http-request.js')
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await handler(
      { url: 'http://private.example.com/', method: 'GET', timeout_ms: 1_000 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects cloud-metadata host', async () => {
    const { handler } = await import('../skills/system/web/tools/http-request.js')
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await handler(
      { url: 'http://metadata.example.com/latest/meta-data/', method: 'GET', timeout_ms: 1_000 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects file: scheme as TOOL_VALIDATION', async () => {
    const { handler } = await import('../skills/system/web/tools/http-request.js')
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    // file: passes Zod url().min check, but the policy must reject it before fetch.
    const result = await handler(
      { url: 'file:///etc/passwd', method: 'GET', timeout_ms: 1_000 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('TOOL_VALIDATION')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('blocks a redirect from public host to private IP (no second fetch)', async () => {
    const { handler } = await import('../skills/system/web/tools/http-request.js')
    let call = 0
    const fetchSpy = vi.fn().mockImplementation(async () => {
      call += 1
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/admin' },
        })
      }
      return new Response('LEAK', { status: 200 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await handler(
      { url: 'http://example.com/start', method: 'GET', timeout_ms: 1_000 },
      handlerCtx as never,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

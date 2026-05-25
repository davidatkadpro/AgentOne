import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchWithPolicy,
  validateFetchUrl,
  type DnsLookupFn,
} from '../skills/system/web/tools/fetch-policy.js'

const publicLookup: DnsLookupFn = async () => [{ address: '93.184.216.34', family: 4 }]
const privateLookup: DnsLookupFn = async () => [{ address: '10.0.0.1', family: 4 }]

describe('validateFetchUrl (re-export sanity)', () => {
  it('keeps the same behaviour the web-fetch tests covered', async () => {
    const ok = await validateFetchUrl('https://example.com/', publicLookup)
    expect(ok.kind).toBe('ok')
    const blocked = await validateFetchUrl('http://169.254.169.254/', publicLookup)
    expect(blocked.kind).toBe('policy')
  })
})

describe('fetchWithPolicy', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('rejects validation errors before issuing fetch', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await fetchWithPolicy('ftp://example.com/', {
      signal: new AbortController().signal,
      lookup: publicLookup,
    })
    expect(result.kind).toBe('validation')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects policy violations (private IP literal) before fetch', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await fetchWithPolicy('http://127.0.0.1/admin', {
      signal: new AbortController().signal,
      lookup: publicLookup,
    })
    expect(result.kind).toBe('policy')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects cloud-metadata IPv4 literal', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await fetchWithPolicy('http://169.254.169.254/latest/meta-data/', {
      signal: new AbortController().signal,
      lookup: publicLookup,
    })
    expect(result.kind).toBe('policy')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects IPv6 loopback literal', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await fetchWithPolicy('http://[::1]/x', {
      signal: new AbortController().signal,
      lookup: publicLookup,
    })
    expect(result.kind).toBe('policy')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects when DNS resolves to a private address', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await fetchWithPolicy('http://intranet.example.com/', {
      signal: new AbortController().signal,
      lookup: privateLookup,
    })
    expect(result.kind).toBe('policy')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('re-validates the Location header on redirect — blocks private redirect target', async () => {
    let call = 0
    const fetchSpy = vi.fn().mockImplementation(async () => {
      call += 1
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/admin' },
        })
      }
      // If we ever fetched the private target, the test fails by leakage.
      return new Response('LEAK', { status: 200 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await fetchWithPolicy('http://example.com/', {
      signal: new AbortController().signal,
      lookup: publicLookup,
    })
    expect(result.kind).toBe('policy')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('re-validates the Location header on redirect — blocks redirect to private host name', async () => {
    let call = 0
    const fetchSpy = vi.fn().mockImplementation(async () => {
      call += 1
      if (call === 1) {
        return new Response(null, {
          status: 301,
          headers: { location: 'http://intranet.example.com/' },
        })
      }
      return new Response('LEAK', { status: 200 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    // First hop: public; second hop: private lookup
    let n = 0
    const lookup: DnsLookupFn = async () => {
      n += 1
      return n === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.0.0.1', family: 4 }]
    }
    const result = await fetchWithPolicy('http://example.com/', {
      signal: new AbortController().signal,
      lookup,
    })
    expect(result.kind).toBe('policy')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('caps redirect chain at MAX_REDIRECTS', async () => {
    const fetchSpy = vi.fn().mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://example.com/next' },
        }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const result = await fetchWithPolicy('http://example.com/', {
      signal: new AbortController().signal,
      lookup: publicLookup,
    })
    expect(result.kind).toBe('runtime')
    if (result.kind === 'runtime') expect(result.error).toMatch(/too many redirects/i)
  })

  it('downgrades POST to GET on a 303 redirect and drops the body', async () => {
    const received: Array<{ method: string; body: BodyInit | null | undefined }> = []
    let call = 0
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      call += 1
      received.push({
        method: init?.method ?? 'GET',
        body: init?.body ?? null,
      })
      if (call === 1) {
        return new Response(null, {
          status: 303,
          headers: { location: 'http://example.com/result' },
        })
      }
      return new Response('OK', { status: 200 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await fetchWithPolicy('http://example.com/', {
      method: 'POST',
      body: 'payload',
      signal: new AbortController().signal,
      lookup: publicLookup,
    })
    expect(result.kind).toBe('ok')
    expect(received[0]?.method).toBe('POST')
    expect(received[0]?.body).toBe('payload')
    expect(received[1]?.method).toBe('GET')
    expect(received[1]?.body ?? null).toBeNull()
  })

  it('preserves method + body across a 307 redirect', async () => {
    const received: Array<{ method: string; body: BodyInit | null | undefined }> = []
    let call = 0
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      call += 1
      received.push({
        method: init?.method ?? 'GET',
        body: init?.body ?? null,
      })
      if (call === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: 'http://example.com/elsewhere' },
        })
      }
      return new Response('OK', { status: 200 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await fetchWithPolicy('http://example.com/', {
      method: 'POST',
      body: 'payload',
      signal: new AbortController().signal,
      lookup: publicLookup,
    })
    expect(result.kind).toBe('ok')
    expect(received[1]?.method).toBe('POST')
    expect(received[1]?.body).toBe('payload')
  })

  it('returns runtime error when redirect lacks Location header', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: {} }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await fetchWithPolicy('http://example.com/', {
      signal: new AbortController().signal,
      lookup: publicLookup,
    })
    expect(result.kind).toBe('runtime')
    if (result.kind === 'runtime') expect(result.error).toMatch(/Location/i)
  })

  it('reports finalUrl after following a public redirect', async () => {
    let call = 0
    const fetchSpy = vi.fn().mockImplementation(async () => {
      call += 1
      if (call === 1) {
        return new Response(null, {
          status: 301,
          headers: { location: 'http://example.com/final' },
        })
      }
      return new Response('OK', { status: 200 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await fetchWithPolicy('http://example.com/', {
      signal: new AbortController().signal,
      lookup: publicLookup,
    })
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.finalUrl).toBe('http://example.com/final')
  })
})

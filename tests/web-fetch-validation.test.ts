import { describe, it, expect } from 'vitest'
import {
  isBlockedIP,
  validateFetchUrl,
  type DnsLookupFn,
} from '../skills/system/web/tools/web-fetch.js'

const lookupOf = (...addresses: string[]): DnsLookupFn => {
  return async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}
const failingLookup: DnsLookupFn = async () => {
  throw new Error('NXDOMAIN')
}

describe('isBlockedIP — IPv4 denylist', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.0.1',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
  ])('blocks %s', (ip) => {
    expect(isBlockedIP(ip)).toBe(true)
  })
})

describe('isBlockedIP — IPv4 allowlist', () => {
  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34', // example.com
    '100.63.255.255', // just before CGNAT
    '100.128.0.0', // just after CGNAT
    '172.15.255.255', // just before private
    '172.32.0.0', // just after private
    '169.253.255.255', // just before link-local
    '169.255.0.0', // just after link-local
    '223.255.255.255', // just before multicast
  ])('allows %s', (ip) => {
    expect(isBlockedIP(ip)).toBe(false)
  })
})

describe('isBlockedIP — IPv6 denylist', () => {
  it.each([
    '::',
    '::1',
    '2001:db8::1',
    '2001:db8::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fea0::',
    'ff00::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.0.0.1', // IPv4-mapped private
    '::ffff:169.254.169.254', // IPv4-mapped metadata
  ])('blocks %s', (ip) => {
    expect(isBlockedIP(ip)).toBe(true)
  })
})

describe('isBlockedIP — IPv6 allowlist', () => {
  it.each([
    '2001:4860:4860::8888', // Google DNS
    '2606:4700:4700::1111', // Cloudflare DNS
    '::ffff:8.8.8.8', // IPv4-mapped public
  ])('allows %s', (ip) => {
    expect(isBlockedIP(ip)).toBe(false)
  })
})

describe('isBlockedIP — malformed input', () => {
  it.each(['', 'not-an-ip', '1.2.3.4.5', '256.0.0.1', '1.2.3'])(
    'blocks %s',
    (ip) => {
      expect(isBlockedIP(ip)).toBe(true)
    },
  )
})

describe('validateFetchUrl', () => {
  const publicLookup = lookupOf('93.184.216.34')

  it('rejects non-http(s) schemes as TOOL_VALIDATION', async () => {
    const r = await validateFetchUrl('ftp://example.com/', publicLookup)
    expect(r.kind).toBe('validation')
  })

  it('rejects javascript: URLs as TOOL_VALIDATION', async () => {
    const r = await validateFetchUrl('javascript:alert(1)', publicLookup)
    expect(r.kind).toBe('validation')
  })

  it('rejects malformed URLs as TOOL_VALIDATION', async () => {
    const r = await validateFetchUrl('::: not a url', publicLookup)
    expect(r.kind).toBe('validation')
  })

  it('reports DNS resolution failure as TOOL_VALIDATION', async () => {
    const r = await validateFetchUrl('https://nx.example.com/', failingLookup)
    expect(r.kind).toBe('validation')
    if (r.kind === 'validation') expect(r.error).toContain('could not resolve')
  })

  it('accepts a URL resolving entirely to public addresses', async () => {
    const r = await validateFetchUrl('https://example.com/path', publicLookup)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.url).toBe('https://example.com/path')
  })

  it('rejects when DNS resolves to a private address as PERMISSION_DENIED', async () => {
    const r = await validateFetchUrl('https://intranet.example.com/', lookupOf('10.0.0.1'))
    expect(r.kind).toBe('policy')
  })

  it('rejects when ANY resolved address is private', async () => {
    const r = await validateFetchUrl(
      'https://mixed.example.com/',
      lookupOf('93.184.216.34', '10.0.0.1'),
    )
    expect(r.kind).toBe('policy')
  })

  it('rejects an IPv4 literal pointing at loopback as policy', async () => {
    const r = await validateFetchUrl('http://127.0.0.1/x', publicLookup)
    expect(r.kind).toBe('policy')
  })

  it('rejects an IPv4 literal pointing at cloud metadata as policy', async () => {
    const r = await validateFetchUrl('http://169.254.169.254/latest/meta-data/', publicLookup)
    expect(r.kind).toBe('policy')
  })

  it('rejects an IPv6 literal pointing at loopback as policy', async () => {
    const r = await validateFetchUrl('http://[::1]/x', publicLookup)
    expect(r.kind).toBe('policy')
  })

  it('accepts a public IPv4 literal', async () => {
    const r = await validateFetchUrl('http://8.8.8.8/', publicLookup)
    expect(r.kind).toBe('ok')
  })

  it('does not invoke DNS for IP literals', async () => {
    let dnsCalled = false
    const trapLookup: DnsLookupFn = async () => {
      dnsCalled = true
      return []
    }
    await validateFetchUrl('http://1.1.1.1/', trapLookup)
    expect(dnsCalled).toBe(false)
  })
})

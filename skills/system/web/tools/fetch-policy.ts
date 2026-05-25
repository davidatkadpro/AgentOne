/**
 * Shared URL/host validation and redirect-following policy for the web skill.
 * Used by web_fetch (content extraction) and http_request (raw HTTP).
 *
 * NOTE: DNS rebinding is not mitigated here. The lookup happens once for the
 * SSRF check, then `fetch` does its own resolution at request time — an
 * attacker with a short-TTL record can swap a public IP for a private one
 * between the two. Acceptable for a single-user local agent; revisit if these
 * tools are ever exposed beyond the operator.
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const MAX_REDIRECTS = 5
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type Validation =
  | { kind: 'ok'; url: string }
  | { kind: 'validation'; error: string }
  | { kind: 'policy'; error: string }

export type DnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>

export async function validateFetchUrl(
  rawUrl: string,
  lookup: DnsLookupFn = dnsLookup,
): Promise<Validation> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { kind: 'validation', error: `invalid URL: ${rawUrl}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'validation', error: 'only http:// and https:// URLs are supported' }
  }
  if (!parsed.hostname) {
    return { kind: 'validation', error: 'URL must include a hostname' }
  }

  const literalHost = stripIPv6Brackets(parsed.hostname)
  let addresses: string[]
  if (isIP(literalHost) !== 0) {
    addresses = [literalHost]
  } else {
    try {
      const results = await lookup(parsed.hostname, { all: true })
      addresses = results.map((r) => r.address)
    } catch (e) {
      return {
        kind: 'validation',
        error: `could not resolve hostname ${parsed.hostname}: ${(e as Error).message}`,
      }
    }
  }

  if (addresses.length === 0) {
    return { kind: 'validation', error: `could not resolve hostname ${parsed.hostname}` }
  }
  const blocked = addresses.filter(isBlockedIP)
  if (blocked.length > 0) {
    return {
      kind: 'policy',
      error: `URL is blocked by security policy: ${parsed.hostname} resolves to ${blocked.join(', ')}`,
    }
  }
  return { kind: 'ok', url: parsed.toString() }
}

function stripIPv6Brackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1)
  return host
}

export function isBlockedIP(ip: string): boolean {
  if (ip.toLowerCase().startsWith('::ffff:')) {
    const v4 = ip.slice(7)
    if (isIP(v4) === 4) return isBlockedIPv4(v4)
  }
  if (isIP(ip) === 4) return isBlockedIPv4(ip)
  if (isIP(ip) === 6) return isBlockedIPv6(ip)
  return true
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((s) => Number(s))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true
  }
  const [a, b, c] = parts as [number, number, number, number]
  if (a === 0) return true
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && c === 0) return true
  if (a === 192 && b === 0 && c === 2) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224 && a <= 239) return true
  if (a >= 240) return true
  return false
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::0') return true
  if (lower === '::1') return true
  if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return true
  if (/^f[cd]/.test(lower)) return true
  if (/^fe[89ab]/.test(lower)) return true
  if (lower.startsWith('ff')) return true
  return false
}

/**
 * Fetch with manual redirect handling, re-validating every hop. Caller passes
 * the request init (method, headers, body) — we own redirect behaviour, the
 * abort signal, and per-hop URL validation.
 *
 * On redirect: re-validate Location and follow up to MAX_REDIRECTS hops.
 * Per RFC 7231, 303 (and historically 301/302) downgrade POST/PUT/etc to GET
 * and drop the body. 307/308 must preserve method and body.
 */
export type FetchWithPolicyResult =
  | { kind: 'ok'; response: Response; finalUrl: string }
  | { kind: 'validation'; error: string }
  | { kind: 'policy'; error: string }
  | { kind: 'runtime'; error: string }

export interface FetchWithPolicyOptions {
  method?: string
  headers?: Record<string, string> | Headers
  body?: BodyInit | null
  signal: AbortSignal
  lookup?: DnsLookupFn
}

export async function fetchWithPolicy(
  rawUrl: string,
  options: FetchWithPolicyOptions,
): Promise<FetchWithPolicyResult> {
  let currentUrl = rawUrl
  let method = (options.method ?? 'GET').toUpperCase()
  let body: BodyInit | null | undefined = options.body
  const headers = options.headers

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const validation = await validateFetchUrl(currentUrl, options.lookup)
    if (validation.kind !== 'ok') return validation

    const response = await fetch(validation.url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: options.signal,
    })

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { kind: 'ok', response, finalUrl: validation.url }
    }

    const location = response.headers.get('location')
    if (!location) {
      return { kind: 'runtime', error: 'Redirect response missing Location header.' }
    }
    if (redirect >= MAX_REDIRECTS) {
      return { kind: 'runtime', error: 'Too many redirects.' }
    }

    if (response.status === 301 || response.status === 302 || response.status === 303) {
      if (method !== 'GET' && method !== 'HEAD') {
        method = 'GET'
        body = undefined
      }
    }

    currentUrl = new URL(location, validation.url).toString()
  }

  return { kind: 'runtime', error: 'Too many redirects.' }
}

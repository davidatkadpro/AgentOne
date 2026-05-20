import { z } from 'zod'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'
import { htmlToReadableText } from './html-to-text.js'
import { readTextWithCap } from './fetch-helpers.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_LENGTH = 15_000
const MIN_MAX_LENGTH = 1_000
const MAX_MAX_LENGTH = 50_000
const MAX_RAW_BYTES = 5_000_000
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; AgentOne/1.0)',
  Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
}

export const parameters = z.object({
  url: z.string().url(),
  max_length: z
    .number()
    .int()
    .min(MIN_MAX_LENGTH)
    .max(MAX_MAX_LENGTH)
    .default(DEFAULT_MAX_LENGTH)
    .describe('Maximum characters of extracted content to return.'),
  timeout_ms: z.number().int().positive().max(120_000).default(DEFAULT_TIMEOUT_MS),
})

export const handler: ToolHandler<typeof parameters> = async (args) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeout_ms)
  const start = Date.now()
  try {
    let currentUrl = args.url
    let response: Response | null = null

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      const validation = await validateFetchUrl(currentUrl)
      if (validation.kind === 'validation') {
        return fail('TOOL_VALIDATION', validation.error, false)
      }
      if (validation.kind === 'policy') {
        return fail('PERMISSION_DENIED', validation.error, false)
      }
      response = await fetch(validation.url, {
        headers: REQUEST_HEADERS,
        redirect: 'manual',
        signal: controller.signal,
      })

      if (!REDIRECT_STATUSES.has(response.status)) break

      const location = response.headers.get('location')
      if (!location) {
        return fail('TOOL_RUNTIME', 'Redirect response missing Location header.', false)
      }
      if (redirect >= MAX_REDIRECTS) {
        return fail('TOOL_RUNTIME', 'Too many redirects.', false)
      }
      currentUrl = new URL(location, validation.url).toString()
    }

    if (!response) {
      return fail('TOOL_RUNTIME', 'No response.', true)
    }
    if (!response.ok) {
      return fail('TOOL_RUNTIME', `HTTP ${response.status}`, true, { status: response.status })
    }

    const contentType = response.headers.get('content-type') ?? ''
    const { text: raw, truncated: truncatedRaw } = await readTextWithCap(
      response,
      MAX_RAW_BYTES,
      controller,
    )
    let body = raw
    let format: 'text' | 'markdown' = 'text'
    if (contentType.toLowerCase().includes('html')) {
      body = htmlToReadableText(body)
      format = 'markdown'
    }

    let truncated = false
    if (body.length > args.max_length) {
      body = body.slice(0, args.max_length) + '\n...(truncated)'
      truncated = true
    }

    return ok({
      url: currentUrl,
      status: response.status,
      content_type: contentType,
      format,
      truncated,
      truncated_raw: truncatedRaw,
      duration_ms: Date.now() - start,
      content: body,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return fail('TOOL_TIMEOUT', `Fetch timed out after ${args.timeout_ms}ms`, true)
    }
    return fail('TOOL_RUNTIME', err instanceof Error ? err.message : String(err), true)
  } finally {
    clearTimeout(timer)
  }
}

export type Validation =
  | { kind: 'ok'; url: string }
  | { kind: 'validation'; error: string }
  | { kind: 'policy'; error: string }

export type DnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>

/**
 * NOTE: DNS rebinding is not mitigated here. The lookup happens once for the
 * SSRF check, then `fetch` does its own resolution at request time — an
 * attacker with a short-TTL record can swap a public IP for a private one
 * between the two. Acceptable for a single-user local agent; revisit if this
 * tool is ever exposed beyond the operator.
 */
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
  // ::ffff:x.x.x.x — re-classify via the embedded IPv4 so v4 rules apply.
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
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 0 && c === 0) return true // IETF
  if (a === 192 && b === 0 && c === 2) return true // TEST-NET-1
  if (a === 192 && b === 168) return true // private
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224 && a <= 239) return true // multicast
  if (a >= 240) return true // reserved / broadcast
  return false
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::0') return true
  if (lower === '::1') return true // loopback
  if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return true // documentation
  if (/^f[cd]/.test(lower)) return true // ULA fc00::/7
  if (/^fe[89ab]/.test(lower)) return true // link-local fe80::/10
  if (lower.startsWith('ff')) return true // multicast
  return false
}

export default { parameters, handler }

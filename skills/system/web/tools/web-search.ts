import { z } from 'zod'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'
import { readTextWithCap } from './fetch-helpers.js'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 500_000
const DDG_URL = 'https://html.duckduckgo.com/html/'
const USER_AGENT = 'Mozilla/5.0 (compatible; AgentOne/1.0)'

export const parameters = z.object({
  query: z.string().min(1).describe('The search query.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('Maximum number of results to return (1-10).'),
  timeout_ms: z.number().int().positive().max(60_000).default(DEFAULT_TIMEOUT_MS),
})

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export const handler: ToolHandler<typeof parameters> = async (args) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeout_ms)
  const start = Date.now()
  try {
    const url = `${DDG_URL}?q=${encodeURIComponent(args.query)}`
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    })
    if (!res.ok) {
      return fail(
        'TOOL_RUNTIME',
        `DuckDuckGo returned HTTP ${res.status}`,
        true,
        { status: res.status },
      )
    }
    const { text: html } = await readTextWithCap(res, MAX_RESPONSE_BYTES, controller)
    const results = parseDuckDuckGoResults(html).slice(0, args.max_results)
    return ok({
      query: args.query,
      count: results.length,
      results,
      duration_ms: Date.now() - start,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return fail('TOOL_TIMEOUT', `Search timed out after ${args.timeout_ms}ms`, true)
    }
    return fail('TOOL_RUNTIME', err instanceof Error ? err.message : String(err), true)
  } finally {
    clearTimeout(timer)
  }
}

const TITLE_RE =
  /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
const SNIPPET_RE =
  /<([a-z]+)[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi

export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const titles: Array<{ url: string | null; title: string }> = []
  for (const m of html.matchAll(TITLE_RE)) {
    titles.push({
      url: extractRedirectUrl(decodeEntities(m[1]!)),
      title: stripTags(m[2]!),
    })
  }
  const snippets: string[] = []
  for (const m of html.matchAll(SNIPPET_RE)) {
    snippets.push(stripTags(m[2]!))
  }
  const out: SearchResult[] = []
  for (let i = 0; i < titles.length; i++) {
    const t = titles[i]!
    if (t.url === null) continue
    out.push({ title: t.title, url: t.url, snippet: snippets[i] ?? '' })
  }
  return out
}

/** Returns the resolved http/https URL, or null for ads, mailto, javascript, etc. */
function extractRedirectUrl(href: string): string | null {
  let resolved: URL
  try {
    resolved = new URL(href, 'https://duckduckgo.com')
  } catch {
    return null
  }
  const uddg = resolved.searchParams.get('uddg')
  let target: URL = resolved
  if (uddg) {
    try {
      target = new URL(uddg)
    } catch {
      return null
    }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null
  return target.toString()
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (full, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = parseInt(name.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    if (name.startsWith('#')) {
      const code = parseInt(name.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    return ENTITY_MAP[name.toLowerCase()] ?? full
  })
}

export default { parameters, handler }

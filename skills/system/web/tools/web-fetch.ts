import { z } from 'zod'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'
import { htmlToReadableText } from './html-to-text.js'
import { readTextWithCap } from './fetch-helpers.js'
import { fetchWithPolicy } from './fetch-policy.js'

// Re-exports preserve external imports (tests, http_request, etc.) that point
// at this file historically. New code should import from ./fetch-policy.js.
export {
  validateFetchUrl,
  isBlockedIP,
  type DnsLookupFn,
  type Validation,
} from './fetch-policy.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_LENGTH = 15_000
const MIN_MAX_LENGTH = 1_000
const MAX_MAX_LENGTH = 50_000
const MAX_RAW_BYTES = 5_000_000
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

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeout_ms)
  const onAbort = (): void => controller.abort()
  if (ctx?.signal) {
    if (ctx.signal.aborted) controller.abort()
    else ctx.signal.addEventListener('abort', onAbort, { once: true })
  }
  const start = Date.now()
  try {
    const result = await fetchWithPolicy(args.url, {
      method: 'GET',
      headers: REQUEST_HEADERS,
      signal: controller.signal,
    })
    if (result.kind === 'validation') return fail('TOOL_VALIDATION', result.error, false)
    if (result.kind === 'policy') return fail('PERMISSION_DENIED', result.error, false)
    if (result.kind === 'runtime') return fail('TOOL_RUNTIME', result.error, false)

    const { response, finalUrl } = result
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
      url: finalUrl,
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
    if (ctx?.signal) ctx.signal.removeEventListener('abort', onAbort)
  }
}

export default { parameters, handler }

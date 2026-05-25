import { z } from 'zod'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'
import { readBodyWithCap } from './fetch-helpers.js'
import { fetchWithPolicy } from './fetch-policy.js'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 200_000

export const parameters = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional().describe('Raw request body as string (often JSON).'),
  timeout_ms: z.number().int().positive().max(120_000).default(DEFAULT_TIMEOUT_MS),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeout_ms)
  // Forward upstream cancellation (turn cancel, tool timeout) so we drop
  // the fetch instead of running to completion after the caller gave up.
  const onAbort = (): void => controller.abort()
  if (ctx?.signal) {
    if (ctx.signal.aborted) controller.abort()
    else ctx.signal.addEventListener('abort', onAbort, { once: true })
  }
  const start = Date.now()
  try {
    const result = await fetchWithPolicy(args.url, {
      method: args.method,
      headers: args.headers,
      body: args.body,
      signal: controller.signal,
    })
    if (result.kind === 'validation') return fail('TOOL_VALIDATION', result.error, false)
    if (result.kind === 'policy') return fail('PERMISSION_DENIED', result.error, false)
    if (result.kind === 'runtime') return fail('TOOL_RUNTIME', result.error, false)

    const { response, finalUrl } = result
    const contentType = response.headers.get('content-type') ?? ''
    const isText =
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml') ||
      contentType.includes('javascript') ||
      contentType.includes('html')

    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => {
      headers[k] = v
    })

    const { buf, truncated } = await readBodyWithCap(response, MAX_BODY_BYTES, controller)

    return ok({
      url: finalUrl,
      status: response.status,
      headers,
      content_type: contentType,
      duration_ms: Date.now() - start,
      truncated,
      ...(isText
        ? { body: buf.toString('utf-8') }
        : {
            body_base64: buf.toString('base64'),
            note: 'binary body — returned as base64',
          }),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return fail(
        'TOOL_TIMEOUT',
        `Request to ${args.url} timed out after ${args.timeout_ms}ms`,
        false,
      )
    }
    return fail(
      'TOOL_RUNTIME',
      err instanceof Error ? err.message : String(err),
      false,
    )
  } finally {
    clearTimeout(timer)
    if (ctx?.signal) ctx.signal.removeEventListener('abort', onAbort)
  }
}

export default { parameters, handler }

import { z } from 'zod'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'
import { readBodyWithCap } from './fetch-helpers.js'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 200_000

export const parameters = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional().describe('Raw request body as string (often JSON).'),
  timeout_ms: z.number().int().positive().max(120_000).default(DEFAULT_TIMEOUT_MS),
})

export const handler: ToolHandler<typeof parameters> = async (args) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeout_ms)
  const start = Date.now()
  try {
    const res = await fetch(args.url, {
      method: args.method,
      headers: args.headers,
      body: args.body,
      signal: controller.signal,
    })
    const contentType = res.headers.get('content-type') ?? ''
    const isText =
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml') ||
      contentType.includes('javascript') ||
      contentType.includes('html')

    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k] = v
    })

    const { buf, truncated } = await readBodyWithCap(res, MAX_BODY_BYTES, controller)

    return ok({
      url: args.url,
      status: res.status,
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
  }
}

export default { parameters, handler }

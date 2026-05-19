import { z } from 'zod'
import { fail, ok, type ToolHandler } from '../../../../src/skills/tool.js'

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

/**
 * Read a Response body up to `cap` bytes, aborting the underlying request
 * when the cap is reached. Without this, `res.arrayBuffer()` would buffer a
 * multi-GB body before truncation — defeating the purpose of the cap.
 */
async function readBodyWithCap(
  res: Response,
  cap: number,
  controller: AbortController,
): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      if (total + value.byteLength > cap) {
        const remaining = cap - total
        if (remaining > 0) chunks.push(value.subarray(0, remaining))
        truncated = true
        controller.abort()
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  return { buf: Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))), truncated }
}

export default { parameters, handler }

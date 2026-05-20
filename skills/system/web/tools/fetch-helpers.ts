/**
 * Internal helpers shared by web tools. Not registered in any SKILL.md
 * `tools:` list, so the skill loader will not pick this up as a tool.
 */

/**
 * Read a Response body up to `cap` bytes, aborting the underlying request
 * when the cap is reached. Without this, `res.arrayBuffer()` would buffer a
 * multi-GB body before truncation — defeating the purpose of the cap.
 */
export async function readBodyWithCap(
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
  return {
    buf: Buffer.concat(
      chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
    ),
    truncated,
  }
}

export async function readTextWithCap(
  res: Response,
  cap: number,
  controller: AbortController,
): Promise<{ text: string; truncated: boolean }> {
  const { buf, truncated } = await readBodyWithCap(res, cap, controller)
  return { text: buf.toString('utf-8'), truncated }
}

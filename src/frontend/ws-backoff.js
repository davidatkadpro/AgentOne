// Tiny module that owns the WebSocket reconnect backoff curve. Lives in
// /src/frontend/ so client.js can import it as an ES module at runtime,
// AND vitest can import it for unit tests. Pure functions, no DOM/WS
// references — keeps the testable bit isolated from the side-effectful
// connectWs() in client.js.

/**
 * Capped exponential backoff. Returns the milliseconds to wait before the
 * next reconnect attempt, given how many attempts have already failed.
 *
 *   attempts = 0 → 1s     (immediately after first drop)
 *   attempts = 1 → 2s
 *   attempts = 2 → 4s
 *   attempts = 3 → 8s
 *   attempts = 4 → 16s
 *   attempts ≥ 5 → 30s (capped)
 *
 * The cap matters: a permanently-broken server shouldn't get hammered
 * once a second forever, but a >30s gap is too long for normal restarts.
 */
export function nextReconnectDelayMs(attempts) {
  if (attempts < 0) attempts = 0
  return Math.min(30_000, 1_000 * Math.pow(2, attempts))
}

/**
 * Compute the user-facing message for a disconnect at attempt N. Returns
 * null when the UI shouldn't render a fresh notice (e.g. a quiet retry
 * mid-backoff). The rendering policy: notice on the first drop, escalation
 * every 5 attempts after that.
 */
export function disconnectNoticeFor(attempts, delayMs) {
  const seconds = Math.round(delayMs / 1000)
  if (attempts === 0) {
    return `Disconnected. Reconnecting in ${seconds}s…`
  }
  if (attempts > 0 && attempts % 5 === 0) {
    return `Still disconnected after ${attempts} retries. Next attempt in ${seconds}s.`
  }
  return null
}

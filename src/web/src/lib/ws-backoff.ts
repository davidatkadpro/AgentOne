export function nextReconnectDelayMs(attempts: number): number {
  if (attempts < 0) attempts = 0
  return Math.min(30_000, 1_000 * Math.pow(2, attempts))
}

export function disconnectNoticeFor(attempts: number, delayMs: number): string | null {
  const seconds = Math.round(delayMs / 1000)
  if (attempts === 0) {
    return `Disconnected. Reconnecting in ${seconds}s…`
  }
  if (attempts > 0 && attempts % 5 === 0) {
    return `Still disconnected after ${attempts} retries. Next attempt in ${seconds}s.`
  }
  return null
}

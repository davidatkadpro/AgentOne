export type RecencyBucket = 'today' | 'week' | 'earlier'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export function recencyBucket(timestamp: number, now: number = Date.now()): RecencyBucket {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const startOfDay = today.getTime()
  if (timestamp >= startOfDay) return 'today'
  if (timestamp >= startOfDay - 6 * MS_PER_DAY) return 'week'
  return 'earlier'
}

export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m`
}

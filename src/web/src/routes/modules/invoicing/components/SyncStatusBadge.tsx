import { cn } from '@/lib/cn'
import type { SyncStatus } from '@/types/domain'

export interface SyncStatusBadgeProps {
  status: SyncStatus
  /** Whether the invoice has ever been pushed (controls "Local only" rendering). */
  hasQboId?: boolean
  className?: string
}

const STYLE: Record<SyncStatus, { label: string; tone: string }> = {
  local: { label: 'Local only', tone: 'bg-bg text-muted border-border' },
  pending: { label: 'Sync pending', tone: 'bg-zinc-500/10 text-muted border-zinc-400/40' },
  synced: {
    label: '↻ Synced',
    tone: 'bg-emerald-500/10 text-emerald-600 border-emerald-400/40',
  },
  drift: { label: '⚠ Drift', tone: 'bg-warn/10 text-warn border-warn/40' },
  failed: { label: '✗ Sync failed', tone: 'bg-danger/10 text-danger border-danger/40' },
}

export function SyncStatusBadge({ status, hasQboId = true, className }: SyncStatusBadgeProps) {
  // A local-only invoice that was never pushed renders with the "Local only" tone
  // regardless of the raw sync_status — the column would otherwise stay at 'local'
  // forever and read as noise.
  const effective: SyncStatus = !hasQboId && status === 'local' ? 'local' : status
  const s = STYLE[effective]
  return (
    <span
      data-testid="sync-status-badge"
      data-status={effective}
      className={cn(
        'inline-flex items-center h-5 px-2 text-[10px] font-medium border rounded',
        s.tone,
        className,
      )}
    >
      {s.label}
    </span>
  )
}

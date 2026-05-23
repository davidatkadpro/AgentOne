import { cn } from '@/lib/cn'

export interface ArtifactStatusBadgeProps {
  displayStatus: string
  className?: string
  /** When true, render with the muted "frozen" treatment used in the editor
   *  read-only banner — superseded artifacts also use this. */
  frozen?: boolean
}

/**
 * Single source of truth for the Estimate · X / Proposal · Y combined status.
 * Phase 4 impl spec §5.3.
 */
const STATUS_STYLE: Record<
  string,
  { tone: string; strike?: boolean; mute?: boolean }
> = {
  'Estimate · draft':
    { tone: 'bg-warn/10 text-warn border-warn/40' },
  'Estimate · ready':
    { tone: 'bg-accent/10 text-accent border-accent/40' },
  'Estimate · accepted':
    { tone: 'bg-emerald-500/10 text-emerald-600 border-emerald-400/40' },
  'Estimate · rejected':
    { tone: 'bg-danger/10 text-danger border-danger/40', mute: true },
  'Estimate · superseded':
    { tone: 'bg-zinc-500/10 text-muted border-zinc-400/40', strike: true, mute: true },
  'Proposal · draft':
    { tone: 'bg-warn/10 text-warn border-warn/40' },
  'Proposal · issued':
    { tone: 'bg-indigo-500/10 text-indigo-600 border-indigo-400/40' },
  'Proposal · accepted':
    { tone: 'bg-emerald-500/10 text-emerald-600 border-emerald-400/40' },
  'Proposal · rejected':
    { tone: 'bg-danger/10 text-danger border-danger/40', mute: true },
  'Proposal · superseded':
    { tone: 'bg-zinc-500/10 text-muted border-zinc-400/40', strike: true, mute: true },
}

const FALLBACK = { tone: 'bg-bg text-muted border-border' }

export function ArtifactStatusBadge({
  displayStatus,
  className,
  frozen,
}: ArtifactStatusBadgeProps) {
  const style = STATUS_STYLE[displayStatus] ?? FALLBACK
  return (
    <span
      data-testid="artifact-status-badge"
      data-status={displayStatus}
      className={cn(
        'inline-flex items-center h-5 px-2 text-[10px] font-medium border rounded',
        style.tone,
        style.strike && 'line-through',
        (style.mute || frozen) && 'opacity-80',
        className,
      )}
    >
      {displayStatus}
    </span>
  )
}

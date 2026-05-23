import { Loader2, Check, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/time'
import type { ToolChipState } from '@/types/domain'

export function ToolChip({ chip }: { chip: ToolChipState }) {
  const icon =
    chip.status === 'pending' ? (
      <Loader2 size={10} className="animate-spin" />
    ) : chip.status === 'done' ? (
      <Check size={10} />
    ) : (
      <X size={10} />
    )
  const title =
    chip.status === 'failed' && chip.failMessage
      ? `${chip.failCode ?? 'failed'}: ${chip.failMessage}`
      : chip.tool
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md border',
        chip.status === 'pending' && 'bg-bg border-border text-muted',
        chip.status === 'done' && 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400',
        chip.status === 'failed' && 'bg-danger/10 border-danger/30 text-danger',
      )}
    >
      {icon}
      <span className="font-mono">{chip.tool}</span>
      {chip.status === 'done' && typeof chip.durationMs === 'number' ? (
        <span className="opacity-70">{formatDuration(chip.durationMs)}</span>
      ) : null}
      {chip.truncated ? <span className="text-warn">truncated</span> : null}
    </span>
  )
}

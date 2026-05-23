import { cn } from '@/lib/cn'
import type { EntityStatus } from '@/types/domain'

export interface ProjectStatusBadgeProps {
  status: EntityStatus
  size?: 'sm' | 'md'
}

const STATUS_STYLE: Record<EntityStatus, { label: string; tone: string }> = {
  pending: {
    label: 'Pending',
    tone: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  active: {
    label: 'Active',
    tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  },
  blocked: {
    label: 'Blocked',
    tone: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  },
  completed: {
    label: 'Completed',
    tone: 'bg-zinc-100 text-zinc-500 line-through',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'bg-zinc-100 text-zinc-400 opacity-60',
  },
}

export function ProjectStatusBadge({ status, size = 'sm' }: ProjectStatusBadgeProps) {
  const style = STATUS_STYLE[status]
  return (
    <span
      data-testid={`project-status-${status}`}
      className={cn(
        'inline-flex items-center rounded-md font-medium',
        size === 'sm' ? 'h-5 px-1.5 text-[10px]' : 'h-6 px-2 text-xs',
        style.tone,
      )}
    >
      {style.label}
    </span>
  )
}

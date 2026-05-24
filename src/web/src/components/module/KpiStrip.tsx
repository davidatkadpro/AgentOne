import { cn } from '@/lib/cn'

export interface KpiPill {
  id: string
  label: string
  count: number
  tone?: 'default' | 'warn' | 'error'
}

export interface KpiStripProps {
  pills: KpiPill[]
  activePillId: string | null
  onPillClick(pillId: string): void
}

export function KpiStrip({ pills, activePillId, onPillClick }: KpiStripProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 overflow-x-auto scrollbar-thin min-w-0">
      {pills.map((pill) => (
        <button
          key={pill.id}
          onClick={() => onPillClick(pill.id)}
          className={cn(
            'h-7 px-2 text-xs rounded-md border flex items-center gap-1.5 shrink-0',
            activePillId === pill.id
              ? 'bg-accent/10 border-accent text-accent'
              : 'bg-bg border-border text-muted hover:text-fg',
            pill.tone === 'warn' && activePillId !== pill.id && 'text-warn',
            pill.tone === 'error' && activePillId !== pill.id && 'text-danger',
          )}
        >
          <span>{pill.label}</span>
          <span className="font-mono font-semibold">{pill.count}</span>
        </button>
      ))}
    </div>
  )
}

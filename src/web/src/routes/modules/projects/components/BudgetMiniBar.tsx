import { cn } from '@/lib/cn'

export interface BudgetMiniBarProps {
  invoicedCents: number
  budgetCents: number | null
}

export function BudgetMiniBar({ invoicedCents, budgetCents }: BudgetMiniBarProps) {
  if (budgetCents == null || budgetCents <= 0) return null
  const pct = (invoicedCents / budgetCents) * 100
  const clamped = Math.max(0, Math.min(100, pct))
  const tone =
    pct > 100
      ? 'bg-danger'
      : pct > 90
        ? 'bg-warn'
        : 'bg-emerald-500/80'
  return (
    <div
      className="flex items-center gap-1.5 text-[10px] text-muted"
      title={`${(invoicedCents / 100).toFixed(0)} / ${(budgetCents / 100).toFixed(0)}`}
    >
      <div className="w-16 h-1.5 rounded-full bg-border overflow-hidden">
        <div className={cn('h-full', tone)} style={{ width: `${clamped}%` }} />
      </div>
      <span className="font-mono tabular-nums">{Math.round(pct)}%</span>
    </div>
  )
}

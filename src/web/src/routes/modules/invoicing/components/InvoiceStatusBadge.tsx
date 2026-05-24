import { cn } from '@/lib/cn'
import type { InvoiceStatus } from '@/types/domain'

export interface InvoiceStatusBadgeProps {
  status: InvoiceStatus
  className?: string
}

/** Spec §5.5 — status enum → visual map. Server-internal `partial` maps to
 *  the user-facing "Partially paid" label. */
const STYLE: Record<InvoiceStatus, { label: string; tone: string; strike?: boolean }> = {
  draft: { label: 'Draft', tone: 'bg-zinc-500/10 text-muted border-zinc-400/40' },
  issued: { label: 'Issued', tone: 'bg-indigo-500/10 text-indigo-600 border-indigo-400/40' },
  partial: {
    label: 'Partially paid',
    tone: 'bg-warn/10 text-warn border-warn/40',
  },
  paid: {
    label: 'Paid',
    tone: 'bg-emerald-500/10 text-emerald-600 border-emerald-400/40',
  },
  void: {
    label: 'Void',
    tone: 'bg-zinc-500/10 text-muted border-zinc-400/40',
    strike: true,
  },
}

export function InvoiceStatusBadge({ status, className }: InvoiceStatusBadgeProps) {
  const s = STYLE[status]
  return (
    <span
      data-testid="invoice-status-badge"
      data-status={status}
      className={cn(
        'inline-flex items-center h-5 px-2 text-[10px] font-medium border rounded',
        s.tone,
        s.strike && 'line-through opacity-80',
        className,
      )}
    >
      {s.label}
    </span>
  )
}

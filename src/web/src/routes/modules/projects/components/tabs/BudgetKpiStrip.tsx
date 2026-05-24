import { useProjectBudget } from '@/api/invoicing'
import type { InvoiceBudget } from '@/types/domain'

export interface BudgetKpiStripProps {
  projectId: string
}

function money(v: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(v)
}

function Pill({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div
      className={`flex flex-col px-3 py-2 border border-border rounded-md bg-bg ${tone ?? ''}`}
      data-testid={`budget-pill-${label.toLowerCase()}`}
    >
      <span className="text-[10px] uppercase text-muted">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </div>
  )
}

export function BudgetKpiStrip({ projectId }: BudgetKpiStripProps) {
  const { data } = useProjectBudget(projectId)
  const b: InvoiceBudget = data ?? {
    projectId,
    budgetTotal: 0,
    invoicedTotal: 0,
    paidTotal: 0,
  }
  const outstanding = Math.max(b.invoicedTotal - b.paidTotal, 0)
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 border-b border-border"
      data-testid="budget-kpi-strip"
    >
      <Pill label="Budget" value={b.budgetTotal > 0 ? money(b.budgetTotal) : '—'} />
      <Pill label="Invoiced" value={money(b.invoicedTotal)} />
      <Pill label="Paid" value={money(b.paidTotal)} />
      <Pill label="Outstanding" value={money(outstanding)} />
    </div>
  )
}

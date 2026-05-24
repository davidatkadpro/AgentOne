import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/time'
import type { Invoice } from '@/types/domain'
import { InvoiceStatusBadge } from './InvoiceStatusBadge'
import { SyncStatusBadge } from './SyncStatusBadge'

export interface InvoiceListRowProps {
  invoice: Invoice
  /** Optional project label to render alongside the invoice number. When
   *  omitted the row shows just the number — used in project-scoped tabs. */
  projectLabel?: { number: string; name: string }
  isActive: boolean
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount)
}

export function InvoiceListRow({ invoice, projectLabel, isActive }: InvoiceListRowProps) {
  const navigate = useNavigate()
  const balance = invoice.total - invoice.amountPaid
  return (
    <div
      data-testid="invoice-row"
      data-active={isActive ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/invoicing/${invoice.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          navigate(`/invoicing/${invoice.id}`)
        }
      }}
      className={cn(
        'px-3 py-2 border-b border-border cursor-pointer flex flex-col gap-1',
        isActive ? 'bg-accent/5' : 'hover:bg-bg/60',
      )}
    >
      <div className="flex items-center gap-2">
        <div className="font-mono text-xs font-medium truncate flex-1">{invoice.number}</div>
        <InvoiceStatusBadge status={invoice.status} />
        <SyncStatusBadge status={invoice.syncStatus} hasQboId={invoice.qboId !== null} />
      </div>
      {projectLabel ? (
        <div className="flex items-center justify-between text-[11px] text-muted">
          <button
            onClick={(e) => {
              e.stopPropagation()
              navigate(`/projects/${invoice.projectId}`)
            }}
            className="hover:underline hover:text-fg truncate"
            data-testid="invoice-row-project-link"
          >
            {projectLabel.number} {projectLabel.name}
          </button>
          <div className="font-mono">{formatMoney(invoice.total)}</div>
        </div>
      ) : (
        <div className="flex items-center justify-end text-[11px] text-muted">
          <div className="font-mono">{formatMoney(invoice.total)}</div>
        </div>
      )}
      <div className="flex items-center justify-between text-[10px] text-muted">
        <span>
          {invoice.amountPaid > 0
            ? `${formatMoney(balance)} balance`
            : `${formatMoney(invoice.total)} due`}
        </span>
        <span title={new Date(invoice.updatedAt).toLocaleString()}>
          {formatRelative(invoice.updatedAt)}
        </span>
      </div>
    </div>
  )
}

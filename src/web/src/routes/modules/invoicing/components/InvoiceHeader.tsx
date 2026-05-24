import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { StatusActionButton, type StatusTransition } from '@/components/module/StatusActionButton'
import { useUpdateInvoice } from '@/api/invoicing'
import type { Invoice, InvoiceStatus } from '@/types/domain'
import { InvoiceStatusBadge } from './InvoiceStatusBadge'
import { SyncStatusBadge } from './SyncStatusBadge'
import { downloadInvoiceUrl } from '@/api/invoicing'

export interface InvoiceHeaderProps {
  invoice: Invoice
  pandocAvailable: boolean
}

function formatMoney(v: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(v)
}

export function InvoiceHeader({ invoice, pandocAvailable }: InvoiceHeaderProps) {
  const navigate = useNavigate()
  const update = useUpdateInvoice(invoice.id)

  function setStatus(next: InvoiceStatus) {
    update.mutate({ status: next })
  }

  const transitions: Record<string, StatusTransition> = {
    draft: {
      primary: { label: 'Mark issued', onClick: () => setStatus('issued') },
      secondary: [{ label: 'Void', onClick: () => setStatus('void') }],
    },
    issued: {
      primary: { label: 'Mark paid', onClick: () => setStatus('paid') },
      secondary: [
        { label: 'Mark partially paid', onClick: () => setStatus('partial') },
        { label: 'Void', onClick: () => setStatus('void') },
      ],
    },
    partial: {
      primary: { label: 'Mark paid', onClick: () => setStatus('paid') },
      secondary: [{ label: 'Void', onClick: () => setStatus('void') }],
    },
    paid: {
      primary: { label: 'Paid', onClick: () => {}, disabled: true },
      secondary: [{ label: 'Void', onClick: () => setStatus('void') }],
    },
    void: {
      primary: { label: 'Void', onClick: () => {}, disabled: true },
      secondary: [],
    },
  }

  return (
    <div className="border-b border-border px-3 py-2 flex items-center gap-3">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold">{invoice.number}</span>
          <InvoiceStatusBadge status={invoice.status} />
          <SyncStatusBadge status={invoice.syncStatus} hasQboId={invoice.qboId !== null} />
        </div>
        <button
          onClick={() => navigate(`/projects/${invoice.projectId}`)}
          className="text-[11px] text-muted hover:text-fg hover:underline"
        >
          Project {invoice.projectId.slice(0, 8)}
        </button>
      </div>
      <div className="text-right text-xs font-mono">
        <div>{formatMoney(invoice.total)}</div>
        {invoice.amountPaid > 0 ? (
          <div className="text-muted">
            {formatMoney(invoice.amountPaid)} paid · {formatMoney(invoice.total - invoice.amountPaid)} bal
          </div>
        ) : null}
      </div>
      <StatusActionButton status={invoice.status} transitions={transitions} />
      <div className="flex items-center gap-1">
        <a
          href={downloadInvoiceUrl(invoice.id, 'md')}
          target="_blank"
          rel="noreferrer"
          className="text-xs underline text-muted hover:text-fg"
          data-testid="download-md"
        >
          MD
        </a>
        {pandocAvailable ? (
          <a
            href={downloadInvoiceUrl(invoice.id, 'pdf')}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline text-muted hover:text-fg"
            data-testid="download-pdf"
          >
            PDF
          </a>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled
            title="Install Pandoc to enable PDF rendering"
          >
            PDF (unavailable)
          </Button>
        )}
      </div>
    </div>
  )
}

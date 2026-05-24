import { CloudUpload, CloudDownload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { formatRelative } from '@/lib/time'
import type { Invoice, QboConnection, InvoiceDrift } from '@/types/domain'
import type { ReconcileRequest } from '@/types/api'
import { usePushInvoice, usePullInvoice, useReconcileInvoice } from '@/api/invoicing-sync'
import { SyncStatusBadge } from './SyncStatusBadge'
import { DriftBlock } from './DriftBlock'

export interface SyncSectionProps {
  invoice: Invoice
  qbo: QboConnection | undefined
  drift: InvoiceDrift | null
  onAgentDispatched?(sessionId: string): void
}

export function SyncSection({ invoice, qbo, drift, onAgentDispatched }: SyncSectionProps) {
  const push = usePushInvoice(invoice.id)
  const pull = usePullInvoice(invoice.id)
  const reconcile = useReconcileInvoice(invoice.id)

  const connected = qbo?.connected === true
  const pushDisabled =
    !connected || invoice.status === 'draft' || push.isPending || invoice.syncStatus === 'drift'
  const pullDisabled =
    !connected || invoice.qboId === null || pull.isPending

  function onResolve(req: ReconcileRequest): void {
    reconcile.mutate(req)
  }

  return (
    <div data-testid="sync-section">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted uppercase">QBO sync</span>
          <SyncStatusBadge
            status={invoice.syncStatus}
            hasQboId={invoice.qboId !== null}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pushDisabled}
            onClick={() => push.mutate({})}
            data-testid="qbo-push-button"
          >
            <CloudUpload size={12} /> Push to QBO
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pullDisabled}
            onClick={() => pull.mutate()}
            data-testid="qbo-pull-button"
          >
            <CloudDownload size={12} /> Pull from QBO
          </Button>
        </div>
      </div>
      <div className="text-xs text-muted space-y-0.5">
        {invoice.qboId ? (
          <div>QBO id · <span className="font-mono">{invoice.qboId}</span></div>
        ) : null}
        {invoice.qboDocNumber ? (
          <div>QBO doc # · <span className="font-mono">{invoice.qboDocNumber}</span></div>
        ) : null}
        {invoice.lastSyncedAt ? (
          <div>Last synced · {formatRelative(invoice.lastSyncedAt)}</div>
        ) : null}
        {invoice.lastError ? (
          <div className="text-danger">
            Last error · {String(invoice.lastError.message ?? invoice.lastError.code ?? '')}
          </div>
        ) : null}
      </div>
      {drift ? (
        <DriftBlock
          drift={drift}
          onResolve={onResolve}
          disabled={reconcile.isPending}
          {...(onAgentDispatched ? { onAgentDispatched } : {})}
        />
      ) : null}
    </div>
  )
}

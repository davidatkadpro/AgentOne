import { useEffect, useRef, useState } from 'react'
import { useInvoice, useUpdateInvoice } from '@/api/invoicing'
import { useQboStatus } from '@/api/qbo'
import { useHealth } from '@/api/health'
import { useModuleActions } from '@/api/module-actions'
import { AskAgentMenu } from '@/components/module/AskAgentMenu'
import { InlineSessionStream } from '@/components/module/InlineSessionStream'
import type { Invoice, InvoiceLine } from '@/types/domain'
import { InvoiceHeader } from './components/InvoiceHeader'
import { InvoiceLineItemsTable } from './components/InvoiceLineItemsTable'
import { PaymentsSection } from './components/PaymentsSection'
import { SyncSection } from './components/SyncSection'

export interface InvoiceDetailRouteProps {
  invoiceId: string
}

/** Debounced auto-save — mirrors EstimateEditor (Phase 4). */
function useDebouncedSave<T>(value: T, save: (v: T) => void, ms = 500): void {
  const lastSaved = useRef<T>(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (lastSaved.current === value) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      save(value)
      lastSaved.current = value
    }, ms)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [value, save, ms])
}

export function InvoiceDetailRoute({ invoiceId }: InvoiceDetailRouteProps) {
  const detail = useInvoice(invoiceId)
  const qbo = useQboStatus().data
  const health = useHealth().data
  const pandocAvailable = health?.capabilities?.pandoc ?? false
  const update = useUpdateInvoice(invoiceId)
  const actions = useModuleActions('invoicing')
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null)
  const [streamOpen, setStreamOpen] = useState(true)

  // Local editing state — falls back to the server invoice until edits start.
  const [lines, setLines] = useState<InvoiceLine[]>([])
  const invoice: Invoice | undefined = detail.data?.invoice
  const payments = detail.data?.payments ?? []
  const drift = detail.data?.drift ?? null

  // Reset local state whenever the server invoice id or update timestamp shifts.
  useEffect(() => {
    if (invoice) setLines(invoice.lines)
  }, [invoice?.id, invoice?.updatedAt])

  useDebouncedSave(lines, (next) => {
    if (!invoice) return
    if (invoice.status === 'paid' || invoice.status === 'void') return
    // Compare against server lines — skip the save when nothing changed (the
    // initial set fires after the effect on first render).
    if (JSON.stringify(next) === JSON.stringify(invoice.lines)) return
    update.mutate({
      lines: next.map((l) => ({
        id: l.id,
        kind: l.kind,
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unitPrice: l.unitPrice,
        metadata: l.metadata,
      })),
    })
  })

  if (detail.isLoading) {
    return <div className="p-4 text-xs text-muted">Loading invoice…</div>
  }
  if (!invoice) {
    return <div className="p-4 text-xs text-muted">Invoice not found.</div>
  }

  const readOnly = invoice.status === 'paid' || invoice.status === 'void'

  return (
    <div className="flex flex-col h-full overflow-auto scrollbar-thin">
      <InvoiceHeader invoice={invoice} pandocAvailable={pandocAvailable} />
      <div className="px-3 py-2 border-b border-border flex items-center justify-end">
        <AskAgentMenu
          module="invoicing"
          tab=""
          contextId={invoiceId}
          skills={actions.data?.actions ?? []}
          onDispatched={(_action, sid) => setAgentSessionId(sid)}
        />
      </div>
      {agentSessionId ? (
        <InlineSessionStream
          sessionId={agentSessionId}
          open={streamOpen}
          onOpenChange={(open) => {
            setStreamOpen(open)
            if (!open) setAgentSessionId(null)
          }}
        />
      ) : null}
      <div className="p-3 space-y-4">
        <section>
          <div className="text-xs font-medium text-muted uppercase mb-2">
            Line items
          </div>
          <InvoiceLineItemsTable
            lines={lines}
            readOnly={readOnly}
            onChange={(idx, update) => {
              setLines((prev) => {
                const next = [...prev]
                const cur = next[idx]
                if (!cur) return prev
                next[idx] = { ...cur, ...update }
                return next
              })
            }}
            onAdd={() => {
              setLines((prev) => [
                ...prev,
                {
                  id: '',
                  invoiceId,
                  kind: 'fixed',
                  description: '',
                  qty: 1,
                  unit: null,
                  unitPrice: 0,
                  lineTotal: 0,
                  position: prev.length,
                  metadata: {},
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
              ])
            }}
            onRemove={(idx) => setLines((prev) => prev.filter((_, i) => i !== idx))}
          />
        </section>
        <section>
          <PaymentsSection invoice={invoice} payments={payments} />
        </section>
        <section>
          <SyncSection
            invoice={invoice}
            qbo={qbo}
            drift={drift}
            onAgentDispatched={(sid) => {
              setAgentSessionId(sid)
              setStreamOpen(true)
            }}
          />
        </section>
      </div>
    </div>
  )
}

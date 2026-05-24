import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { formatRelative } from '@/lib/time'
import type { Invoice, Payment } from '@/types/domain'
import { RecordPaymentDialog } from './RecordPaymentDialog'

export interface PaymentsSectionProps {
  invoice: Invoice
  payments: Payment[]
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount)
}

export function PaymentsSection({ invoice, payments }: PaymentsSectionProps) {
  const [open, setOpen] = useState(false)
  const balance = invoice.total - invoice.amountPaid
  const closed = invoice.status === 'paid' || invoice.status === 'void'

  return (
    <div data-testid="payments-section">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-muted uppercase">Payments</div>
        {!closed ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen(true)}
            data-testid="record-payment-open"
          >
            <Plus size={12} /> Record payment
          </Button>
        ) : null}
      </div>
      {payments.length === 0 ? (
        <div className="text-xs text-muted">No payments recorded.</div>
      ) : (
        <div className="space-y-1">
          {payments.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between text-xs px-2 py-1 border-b border-border/40"
              data-testid="payment-row"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono">{formatMoney(p.amount)}</span>
                <span className="text-muted">{p.method}</span>
                {p.reference ? (
                  <span className="text-muted">#{p.reference}</span>
                ) : null}
              </div>
              <span className="text-muted text-[11px]">
                {formatRelative(p.receivedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 pt-2 border-t border-border flex items-center justify-between text-xs">
        <span className="text-muted">Balance</span>
        <span className="font-mono font-medium">{formatMoney(balance)}</span>
      </div>
      <RecordPaymentDialog
        invoiceId={invoice.id}
        open={open}
        onOpenChange={setOpen}
        suggestedAmount={Math.max(balance, 0)}
      />
    </div>
  )
}

import { useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useRecordPayment } from '@/api/invoicing'
import type { PaymentMethod } from '@/types/domain'

export interface RecordPaymentDialogProps {
  invoiceId: string
  open: boolean
  onOpenChange(open: boolean): void
  /** Suggested amount — usually the invoice balance. */
  suggestedAmount: number
}

const METHODS: PaymentMethod[] = ['check', 'ach', 'card', 'wire', 'cash', 'other']

export function RecordPaymentDialog({
  invoiceId,
  open,
  onOpenChange,
  suggestedAmount,
}: RecordPaymentDialogProps) {
  const [amount, setAmount] = useState<string>(suggestedAmount.toFixed(2))
  const [method, setMethod] = useState<PaymentMethod>('check')
  const [reference, setReference] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const record = useRecordPayment(invoiceId)

  async function commit() {
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) return
    const body: Parameters<typeof record.mutateAsync>[0] = { amount: amt, method }
    if (reference.trim()) body.reference = reference.trim()
    if (notes.trim()) body.notes = notes.trim()
    await record.mutateAsync(body)
    onOpenChange(false)
    // Reset for next time.
    setReference('')
    setNotes('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Record payment">
      <div className="space-y-3 text-sm">
        <label className="block">
          <div className="text-xs text-muted mb-1">Amount</div>
          <Input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
            data-testid="record-payment-amount"
          />
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Method</div>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            className="h-9 w-full px-2 text-sm bg-bg border border-border rounded-md"
            data-testid="record-payment-method"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Reference</div>
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Check #, ACH id, etc."
          />
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Notes</div>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={commit}
            disabled={record.isPending}
            data-testid="record-payment-commit"
          >
            {record.isPending ? 'Recording…' : 'Record'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

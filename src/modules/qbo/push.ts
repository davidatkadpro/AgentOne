import type { Invoice } from '../../../modules/invoicing/src/service.js'
import type { QboInvoiceDoc, QboLineItem } from './source.js'

/** Build a QBO Invoice doc from our local Invoice. We keep the mapping in
 *  one place because both push.ts and pull.ts depend on the shape. */
export function localToQbo(
  invoice: Invoice,
  customerRef: { value: string; name?: string },
  existing?: QboInvoiceDoc,
): QboInvoiceDoc {
  const lines: QboLineItem[] = invoice.lines.map((l) => ({
    description: l.description,
    amount: l.lineTotal,
    qty: l.qty,
    unitPrice: l.unitPrice,
  }))
  const doc: QboInvoiceDoc = {
    Id: existing?.Id ?? '',
    DocNumber: invoice.number,
    TotalAmt: invoice.total,
    Balance: invoice.total - invoice.amountPaid,
    CustomerRef: customerRef,
    Line: lines,
  }
  if (invoice.issuedAt !== null) {
    doc.TxnDate = new Date(invoice.issuedAt).toISOString().slice(0, 10)
  }
  if (invoice.dueDate !== null) {
    doc.DueDate = new Date(invoice.dueDate).toISOString().slice(0, 10)
  }
  if (existing?.SyncToken !== undefined) {
    doc.SyncToken = existing.SyncToken
  }
  return doc
}

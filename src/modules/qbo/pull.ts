import type { Invoice } from '../../../modules/invoicing/src/service.js'
import type { QboInvoiceDoc } from './source.js'

/**
 * Compare a local invoice with the QBO doc and return the list of divergent
 * field paths. Order is stable so the UI can highlight consistently.
 */
export function detectDrift(local: Invoice, remote: QboInvoiceDoc): string[] {
  const out: string[] = []

  if (remote.DocNumber !== local.number) {
    out.push('number')
  }
  // Money fields — compare to the cent so floating-point noise doesn't trip
  // false drift. We round before comparing.
  if (round2(remote.TotalAmt) !== round2(local.total)) {
    out.push('total')
  }
  if (round2(remote.Balance) !== round2(local.total - local.amountPaid)) {
    out.push('balance')
  }

  const remoteLines = remote.Line ?? []
  if (remoteLines.length !== local.lines.length) {
    out.push('lineCount')
  } else {
    for (let i = 0; i < remoteLines.length; i += 1) {
      const r = remoteLines[i]
      const l = local.lines[i]
      if (!r || !l) continue
      if (r.description !== l.description) out.push(`lines[${i}].description`)
      if (round2(r.amount) !== round2(l.lineTotal)) out.push(`lines[${i}].amount`)
    }
  }

  if (remote.DueDate && local.dueDate !== null) {
    const localDateStr = new Date(local.dueDate).toISOString().slice(0, 10)
    if (remote.DueDate !== localDateStr) out.push('dueDate')
  }
  return out
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Project a QBO doc into a side-by-side-friendly Record shape. The UI
 *  iterates `driftFields[]` and reads `local[field]` / `qbo[field]`. */
export function buildSnapshots(
  local: Invoice,
  remote: QboInvoiceDoc,
  driftFields: string[],
): {
  local: Record<string, unknown>
  qbo: Record<string, unknown>
} {
  const l: Record<string, unknown> = {}
  const q: Record<string, unknown> = {}
  for (const field of driftFields) {
    if (field === 'number') {
      l[field] = local.number
      q[field] = remote.DocNumber
    } else if (field === 'total') {
      l[field] = local.total
      q[field] = remote.TotalAmt
    } else if (field === 'balance') {
      l[field] = local.total - local.amountPaid
      q[field] = remote.Balance
    } else if (field === 'lineCount') {
      l[field] = local.lines.length
      q[field] = (remote.Line ?? []).length
    } else if (field === 'dueDate') {
      l[field] = local.dueDate
        ? new Date(local.dueDate).toISOString().slice(0, 10)
        : null
      q[field] = remote.DueDate ?? null
    } else {
      const m = /^lines\[(\d+)\]\.(.+)$/.exec(field)
      if (m && m[1] !== undefined && m[2] !== undefined) {
        const idx = Number(m[1])
        const prop = m[2]
        const ll = local.lines[idx]
        const rl = (remote.Line ?? [])[idx]
        if (ll) {
          l[field] = prop === 'description' ? ll.description : ll.lineTotal
        }
        if (rl) {
          q[field] = prop === 'description' ? rl.description : rl.amount
        }
      }
    }
  }
  return { local: l, qbo: q }
}

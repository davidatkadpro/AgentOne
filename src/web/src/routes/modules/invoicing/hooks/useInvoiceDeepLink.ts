import { useSearchParams } from 'react-router-dom'
import type { InvoiceStatus, SyncStatus } from '@/types/domain'

export type InvoiceFilterId =
  | 'all'
  | 'draft'
  | 'issued'
  | 'partial'
  | 'paid'
  | 'void'
  | 'overdue'
  | 'drift'
  | 'sync_failed'

export const FILTER_TO_STATUS: Record<InvoiceFilterId, InvoiceStatus[] | undefined> = {
  all: undefined,
  draft: ['draft'],
  issued: ['issued'],
  partial: ['partial'],
  paid: ['paid'],
  void: ['void'],
  overdue: ['issued', 'partial'], // narrowed further by dueDate filter at use site
  drift: undefined,
  sync_failed: undefined,
}

export const FILTER_TO_SYNC: Record<InvoiceFilterId, SyncStatus[] | undefined> = {
  all: undefined,
  draft: undefined,
  issued: undefined,
  partial: undefined,
  paid: undefined,
  void: undefined,
  overdue: undefined,
  drift: ['drift'],
  sync_failed: ['failed'],
}

const ALL: ReadonlySet<InvoiceFilterId> = new Set([
  'all',
  'draft',
  'issued',
  'partial',
  'paid',
  'void',
  'overdue',
  'drift',
  'sync_failed',
])

export function isInvoiceFilter(s: string | null): s is InvoiceFilterId {
  return s !== null && ALL.has(s as InvoiceFilterId)
}

export function useInvoiceDeepLink() {
  const [search, setSearch] = useSearchParams()
  const raw = search.get('filter')
  const filter: InvoiceFilterId = isInvoiceFilter(raw) ? raw : 'all'
  const projectId = search.get('project')
  function setFilter(next: InvoiceFilterId | null): void {
    const updated = new URLSearchParams(search)
    if (next === null || next === 'all') updated.delete('filter')
    else updated.set('filter', next)
    setSearch(updated, { replace: true })
  }
  return { filter, projectId, setFilter, search, setSearch }
}

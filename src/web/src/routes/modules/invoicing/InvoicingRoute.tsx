import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { ModulePanel } from '@/components/module/ModulePanel'
import { KpiStrip, type KpiPill } from '@/components/module/KpiStrip'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useInvoices } from '@/api/invoicing'
import { useQboStatus } from '@/api/qbo'
import { useProjects } from '@/api/projects'
import type { Invoice } from '@/types/domain'
import { InvoiceListRow } from './components/InvoiceListRow'
import { ConnectionBanner } from './components/ConnectionBanner'
import { NewInvoiceDialog } from './components/NewInvoiceDialog'
import { InvoiceDetailRoute } from './InvoiceDetailRoute'
import {
  useInvoiceDeepLink,
  FILTER_TO_STATUS,
  FILTER_TO_SYNC,
  type InvoiceFilterId,
} from './hooks/useInvoiceDeepLink'

function isOverdue(inv: Invoice): boolean {
  if (inv.dueDate === null) return false
  if (inv.status !== 'issued' && inv.status !== 'partial') return false
  return inv.dueDate < Date.now()
}

export function InvoicingRoute() {
  const navigate = useNavigate()
  const params = useParams<{ invoiceId?: string }>()
  const { filter, projectId: projectFilter, setFilter, search, setSearch } =
    useInvoiceDeepLink()
  const [query, setQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)

  const baseInvoices = useInvoices(projectFilter ? { projectId: projectFilter } : undefined)
  const invoices = baseInvoices.data ?? []
  const qbo = useQboStatus().data ?? { connected: false }
  const projects = useProjects()
  const projectsById = useMemo(() => {
    const m = new Map<string, { number: string; name: string }>()
    for (const p of projects.data ?? []) m.set(p.id, { number: p.number, name: p.name })
    return m
  }, [projects.data])

  const visible = useMemo<Invoice[]>(() => {
    let rows = invoices
    if (filter === 'overdue') {
      rows = rows.filter(isOverdue)
    } else {
      const statuses = FILTER_TO_STATUS[filter]
      if (statuses) rows = rows.filter((r) => statuses.includes(r.status))
      const syncs = FILTER_TO_SYNC[filter]
      if (syncs) rows = rows.filter((r) => syncs.includes(r.syncStatus))
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      rows = rows.filter((r) => {
        const pl = projectsById.get(r.projectId)
        return (
          r.number.toLowerCase().includes(q) ||
          pl?.number.toLowerCase().includes(q) ||
          pl?.name.toLowerCase().includes(q)
        )
      })
    }
    return rows
  }, [invoices, filter, query, projectsById])

  const kpis: KpiPill[] = useMemo(() => {
    let outstanding = 0
    let overdue = 0
    let drift = 0
    let failed = 0
    for (const inv of invoices) {
      if (inv.status === 'issued' || inv.status === 'partial') {
        outstanding += inv.total - inv.amountPaid
        if (isOverdue(inv)) overdue += inv.total - inv.amountPaid
      }
      if (inv.syncStatus === 'drift') drift += 1
      if (inv.syncStatus === 'failed') failed += 1
    }
    return [
      {
        id: 'outstanding',
        label: `$${Math.round(outstanding).toLocaleString()} outstanding`,
        count: 0,
        tone: outstanding > 0 ? 'warn' : 'default',
      },
      {
        id: 'overdue',
        label: `$${Math.round(overdue).toLocaleString()} overdue`,
        count: 0,
        tone: overdue > 0 ? 'warn' : 'default',
      },
      {
        id: 'drift',
        label: 'Drift',
        count: drift,
        tone: drift > 0 ? 'warn' : 'default',
      },
      {
        id: 'sync_failed',
        label: 'Sync failed',
        count: failed,
        tone: failed > 0 ? 'warn' : 'default',
      },
    ]
  }, [invoices])

  function onPillClick(id: string) {
    if (id === 'outstanding') {
      // Outstanding is informational — clicking should narrow to issued+partial.
      setFilter('issued')
      return
    }
    if (id === 'overdue') {
      setFilter('overdue')
      return
    }
    if (id === filter) setFilter(null)
    else setFilter(id as InvoiceFilterId)
  }

  const selectedId = params.invoiceId ?? null

  return (
    <>
      <ModulePanel
        kpiStrip={
          <div className="flex flex-col">
            <ConnectionBanner qbo={qbo} />
            <div className="flex items-center justify-between pr-3">
              <KpiStrip
                pills={kpis}
                activePillId={filter === 'all' ? null : filter}
                onPillClick={onPillClick}
              />
              <Button
                size="sm"
                onClick={() => setDialogOpen(true)}
                data-testid="new-invoice-button"
              >
                <Plus size={12} /> New invoice
              </Button>
            </div>
          </div>
        }
        list={
          <div className="flex flex-col h-full">
            <div className="p-2 border-b border-border">
              <div className="relative">
                <Search
                  size={12}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-muted"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search invoices…"
                  className="h-8 pl-7 text-xs"
                  data-testid="invoicing-search"
                />
              </div>
              {projectFilter ? (
                <button
                  onClick={() => {
                    const next = new URLSearchParams(search)
                    next.delete('project')
                    setSearch(next, { replace: true })
                  }}
                  className="mt-1 text-[10px] text-muted hover:text-fg underline"
                >
                  Clear project filter
                </button>
              ) : null}
            </div>
            {baseInvoices.isLoading ? (
              <div className="p-4 text-xs text-muted">Loading invoices…</div>
            ) : visible.length === 0 ? (
              <EmptyState
                title={
                  invoices.length === 0
                    ? 'No invoices yet'
                    : 'No invoices match the filter'
                }
                body={
                  invoices.length === 0
                    ? 'Create one from + New invoice.'
                    : 'Try clearing filters or the search box.'
                }
              />
            ) : (
              <div className="flex-1 overflow-auto scrollbar-thin">
                {visible.map((inv) => {
                  const projectLabel = projectsById.get(inv.projectId)
                  return (
                    <InvoiceListRow
                      key={inv.id}
                      invoice={inv}
                      {...(projectLabel ? { projectLabel } : {})}
                      isActive={inv.id === selectedId}
                    />
                  )
                })}
              </div>
            )}
          </div>
        }
        detail={selectedId ? <InvoiceDetailRoute invoiceId={selectedId} /> : null}
        emptyState={
          <EmptyState
            title="Select an invoice"
            body="Pick an invoice from the list to edit lines, record payments, or push to QBO."
          />
        }
      />
      <NewInvoiceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        {...(projectFilter ? { defaultProjectId: projectFilter } : {})}
        onCreated={(id) => navigate(`/invoicing/${id}`)}
      />
    </>
  )
}

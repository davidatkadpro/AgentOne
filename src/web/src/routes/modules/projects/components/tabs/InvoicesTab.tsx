import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/shared/EmptyState'
import { useInvoices } from '@/api/invoicing'
import { useProject } from '@/api/projects'
import { InvoiceListRow } from '../../../invoicing/components/InvoiceListRow'
import { NewInvoiceDialog } from '../../../invoicing/components/NewInvoiceDialog'
import { BudgetKpiStrip } from './BudgetKpiStrip'

export interface InvoicesTabProps {
  projectId: string
}

export function InvoicesTab({ projectId }: InvoicesTabProps) {
  const navigate = useNavigate()
  const rows = useInvoices({ projectId })
  const project = useProject(projectId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const projectLabel = useMemo(() => {
    const p = project.data?.project
    if (!p) return undefined
    return { number: p.number, name: p.name }
  }, [project.data])

  return (
    <div className="flex flex-col h-full" data-testid="project-invoices-tab">
      <BudgetKpiStrip projectId={projectId} />
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <h2 className="text-xs font-semibold">Invoices</h2>
        <Button
          size="sm"
          onClick={() => setDialogOpen(true)}
          data-testid="project-new-invoice-button"
        >
          <Plus size={12} /> New
        </Button>
      </div>
      {rows.isLoading ? (
        <div className="p-3 text-xs text-muted">Loading…</div>
      ) : (rows.data ?? []).length === 0 ? (
        <EmptyState
          title="No invoices for this project yet"
          body="Create one from + New, or run the create-invoice skill."
        />
      ) : (
        <div className="flex-1 overflow-auto scrollbar-thin">
          {(rows.data ?? []).map((inv) => (
            <InvoiceListRow
              key={inv.id}
              invoice={inv}
              {...(projectLabel ? { projectLabel } : {})}
              isActive={false}
            />
          ))}
        </div>
      )}
      <NewInvoiceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultProjectId={projectId}
        onCreated={(id) => navigate(`/invoicing/${id}`)}
      />
    </div>
  )
}

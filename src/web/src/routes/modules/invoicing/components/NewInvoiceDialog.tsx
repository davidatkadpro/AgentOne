import { useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useProjects } from '@/api/projects'
import { useArtifacts } from '@/api/proposals'
import { useCreateInvoice, useCreateInvoiceFromProposal } from '@/api/invoicing'

export interface NewInvoiceDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** When supplied, the project picker is hidden and locked. */
  defaultProjectId?: string
  onCreated(invoiceId: string): void
}

type Tab = 'proposal' | 'blank'

export function NewInvoiceDialog({
  open,
  onOpenChange,
  defaultProjectId,
  onCreated,
}: NewInvoiceDialogProps) {
  const [tab, setTab] = useState<Tab>('proposal')
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? '')
  const projects = useProjects()
  const artifacts = useArtifacts(projectId ? { projectId } : undefined)
  const accepted = (artifacts.data ?? []).filter(
    (a) => a.displayStatus === 'Proposal · accepted',
  )
  const [proposalId, setProposalId] = useState<string>('')
  const [blankDesc, setBlankDesc] = useState<string>('Phase 1')
  const [blankAmount, setBlankAmount] = useState<string>('1000.00')

  const createBlank = useCreateInvoice(projectId)
  const createFromProposal = useCreateInvoiceFromProposal(projectId)

  async function commit() {
    if (!projectId) return
    if (tab === 'proposal') {
      if (!proposalId) return
      const res = await createFromProposal.mutateAsync({ proposalId })
      onCreated(res.invoice.id)
    } else {
      const amt = Number(blankAmount)
      if (!Number.isFinite(amt) || amt <= 0) return
      const res = await createBlank.mutateAsync({
        lines: [{ description: blankDesc, qty: 1, unitPrice: amt }],
      })
      onCreated(res.invoice.id)
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New invoice">
      <div className="space-y-3 text-sm">
        {!defaultProjectId ? (
          <label className="block">
            <div className="text-xs text-muted mb-1">Project</div>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="h-9 w-full px-2 text-sm bg-bg border border-border rounded-md"
              data-testid="new-invoice-project"
            >
              <option value="">Select…</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="flex border-b border-border">
          <button
            onClick={() => setTab('proposal')}
            className={`px-3 py-1.5 text-xs ${
              tab === 'proposal'
                ? 'border-b-2 border-accent text-fg'
                : 'text-muted hover:text-fg'
            }`}
            data-testid="tab-from-proposal"
          >
            From proposal
          </button>
          <button
            onClick={() => setTab('blank')}
            className={`px-3 py-1.5 text-xs ${
              tab === 'blank'
                ? 'border-b-2 border-accent text-fg'
                : 'text-muted hover:text-fg'
            }`}
            data-testid="tab-blank"
          >
            Blank
          </button>
        </div>

        {tab === 'proposal' ? (
          <div>
            {!projectId ? (
              <div className="text-xs text-muted">Select a project first.</div>
            ) : accepted.length === 0 ? (
              <div className="text-xs text-muted">
                No accepted proposals for this project.
              </div>
            ) : (
              <label className="block">
                <div className="text-xs text-muted mb-1">Accepted proposal</div>
                <select
                  value={proposalId}
                  onChange={(e) => setProposalId(e.target.value)}
                  className="h-9 w-full px-2 text-sm bg-bg border border-border rounded-md"
                  data-testid="new-invoice-proposal"
                >
                  <option value="">Select…</option>
                  {accepted.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.number} · ${(p.totalCents / 100).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block">
              <div className="text-xs text-muted mb-1">Description</div>
              <Input
                value={blankDesc}
                onChange={(e) => setBlankDesc(e.target.value)}
              />
            </label>
            <label className="block">
              <div className="text-xs text-muted mb-1">Amount</div>
              <Input
                type="number"
                step="0.01"
                value={blankAmount}
                onChange={(e) => setBlankAmount(e.target.value)}
              />
            </label>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={commit}
            disabled={
              !projectId ||
              (tab === 'proposal' && !proposalId) ||
              createBlank.isPending ||
              createFromProposal.isPending
            }
            data-testid="new-invoice-commit"
          >
            Create
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

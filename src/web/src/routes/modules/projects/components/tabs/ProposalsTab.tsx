import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/shared/EmptyState'
import { useArtifacts } from '@/api/proposals'
import { ArtifactListRow } from '../../../proposals/components/ArtifactListRow'
import { NewProposalDialog } from '../../../proposals/components/NewProposalDialog'

export interface ProposalsTabProps {
  projectId: string
}

export function ProposalsTab({ projectId }: ProposalsTabProps) {
  const navigate = useNavigate()
  const rows = useArtifacts({ projectId })
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <div className="flex flex-col h-full" data-testid="project-proposals-tab">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <h2 className="text-xs font-semibold">Proposals</h2>
        <Button
          size="sm"
          onClick={() => setDialogOpen(true)}
          data-testid="project-new-proposal-button"
        >
          <Plus size={12} /> New
        </Button>
      </div>
      {rows.isLoading ? (
        <div className="p-3 text-xs text-muted">Loading…</div>
      ) : (rows.data ?? []).length === 0 ? (
        <EmptyState
          title="No proposals for this project yet"
          body="Create one from the + New button or run the build-estimate skill."
        />
      ) : (
        <div className="flex-1 overflow-auto scrollbar-thin">
          {(rows.data ?? []).map((row) => (
            <ArtifactListRow key={`${row.kind}-${row.id}`} row={row} isActive={false} />
          ))}
        </div>
      )}
      <NewProposalDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultProjectId={projectId}
        onCreated={(id) => navigate(`/proposals/${id}`)}
      />
    </div>
  )
}

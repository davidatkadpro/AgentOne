import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EmptyState } from '@/components/shared/EmptyState'
import { useProposalDetail } from '@/api/proposals'
import { useHealth } from '@/api/health'
import { EstimateEditor } from './components/EstimateEditor'
import { ProposalPreview } from './components/ProposalPreview'
import { ProposalToolbar } from './components/ProposalToolbar'
import { HistoryPopover } from './components/HistoryPopover'

export interface ProposalDetailRouteProps {
  artifactId: string
}

export function ProposalDetailRoute({ artifactId }: ProposalDetailRouteProps) {
  const navigate = useNavigate()
  const detail = useProposalDetail(artifactId)
  const health = useHealth()
  const [historyOpen, setHistoryOpen] = useState(false)

  if (detail.isLoading) {
    return <div className="p-4 text-xs text-muted">Loading…</div>
  }
  if (!detail.data) {
    return (
      <EmptyState
        title="Not found"
        body="This proposal or estimate may have been removed."
      />
    )
  }
  const { estimate, proposal } = detail.data
  const status = proposal ? proposal.status : estimate.status
  const readOnly =
    status === 'accepted' || status === 'rejected' || status === 'superseded'
  const pandocAvailable = health.data?.capabilities?.pandoc ?? false

  return (
    <div className="flex flex-col h-full" data-testid="proposal-detail">
      <ProposalToolbar
        estimate={estimate}
        proposal={proposal}
        pandocAvailable={pandocAvailable}
        detailIdForCache={artifactId}
        onNavigate={(toId) => navigate(`/proposals/${toId}`)}
        onHistoryToggle={() => setHistoryOpen((v) => !v)}
      />
      <HistoryPopover
        artifactId={artifactId}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      />
      <div className="flex-1 grid grid-cols-2 overflow-hidden">
        <div className="overflow-auto scrollbar-thin border-r border-border">
          <EstimateEditor
            estimate={estimate}
            readOnly={readOnly}
            detailIdForCache={artifactId}
          />
        </div>
        <div className="overflow-hidden">
          <ProposalPreview
            proposalId={proposal?.id ?? null}
            watchKey={estimate.updatedAt}
          />
        </div>
      </div>
    </div>
  )
}

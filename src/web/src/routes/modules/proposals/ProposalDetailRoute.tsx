import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EmptyState } from '@/components/shared/EmptyState'
import { AskAgentMenu } from '@/components/module/AskAgentMenu'
import { InlineSessionStream } from '@/components/module/InlineSessionStream'
import { useProposalDetail } from '@/api/proposals'
import { useModuleActions } from '@/api/module-actions'
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
  const actions = useModuleActions('proposals')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null)
  const [streamOpen, setStreamOpen] = useState(true)

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
      <div className="px-3 py-1.5 border-b border-border flex items-center justify-end">
        <AskAgentMenu
          module="proposals"
          tab=""
          contextId={proposal?.id ?? estimate.id}
          skills={actions.data?.actions ?? []}
          onDispatched={(_action, sid) => {
            setAgentSessionId(sid)
            setStreamOpen(true)
          }}
        />
      </div>
      {agentSessionId ? (
        <InlineSessionStream
          sessionId={agentSessionId}
          open={streamOpen}
          onOpenChange={(open) => {
            setStreamOpen(open)
            if (!open) setAgentSessionId(null)
          }}
        />
      ) : null}
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

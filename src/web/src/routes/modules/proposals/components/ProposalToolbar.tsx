import { useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AlertDialog } from '@/components/ui/Dialog'
import { StatusActionButton, type StatusTransition } from '@/components/module/StatusActionButton'
import {
  useReviseEstimate,
  useUpdateEstimate,
  useUpdateProposal,
  useCreateProposal,
  downloadProposalUrl,
} from '@/api/proposals'
import type { Estimate, Proposal } from '@/types/domain'
import { ArtifactStatusBadge } from './ArtifactStatusBadge'

export interface ProposalToolbarProps {
  estimate: Estimate
  proposal: Proposal | null
  pandocAvailable: boolean
  detailIdForCache: string
  onNavigate(toId: string): void
  onHistoryToggle(): void
}

export function ProposalToolbar({
  estimate,
  proposal,
  pandocAvailable,
  detailIdForCache,
  onNavigate,
  onHistoryToggle,
}: ProposalToolbarProps) {
  const updateEstimate = useUpdateEstimate(estimate.id, detailIdForCache)
  const createProposal = useCreateProposal(estimate.projectId)
  const updateProposal = useUpdateProposal(proposal?.id ?? '', detailIdForCache)
  const reviseEstimate = useReviseEstimate()
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [confirmRevise, setConfirmRevise] = useState(false)

  // Combined display status surfaced in the badge + state machine.
  const displayStatus = proposal
    ? `Proposal · ${proposal.status}`
    : `Estimate · ${estimate.status}`

  const transitions: Record<string, StatusTransition> = {
    'Estimate · draft': {
      primary: {
        label: 'Mark ready',
        onClick: () =>
          updateEstimate.mutate(
            { status: 'ready' },
            {
              onSuccess: () => toast.success('Estimate marked ready.'),
            },
          ),
      },
      secondary: [],
    },
    'Estimate · ready': {
      primary: {
        label: 'Issue proposal',
        onClick: () =>
          createProposal.mutate(
            { estimateId: estimate.id },
            {
              onSuccess: (res) => {
                toast.success(`Proposal ${res.proposal.number} created.`)
                onNavigate(res.proposal.id)
              },
            },
          ),
        disabled: createProposal.isPending,
      },
      secondary: [],
    },
    'Proposal · draft': {
      primary: {
        label: 'Issue',
        onClick: () =>
          updateProposal.mutate(
            { status: 'issued' },
            {
              onSuccess: () => toast.success('Proposal issued.'),
            },
          ),
      },
      secondary: [],
    },
    'Proposal · issued': {
      primary: {
        label: 'Mark accepted',
        onClick: () =>
          updateProposal.mutate(
            { status: 'accepted' },
            {
              onSuccess: () => toast.success('Proposal accepted.'),
            },
          ),
      },
      secondary: [
        {
          label: 'Mark rejected',
          onClick: () =>
            updateProposal.mutate(
              { status: 'rejected' },
              {
                onSuccess: () => toast.success('Proposal rejected.'),
              },
            ),
        },
      ],
    },
  }

  const downloadOpts: Array<{ label: string; format: 'md' | 'pdf' | 'docx'; available: boolean }> =
    proposal
      ? [
          { label: 'Download Markdown', format: 'md', available: true },
          { label: 'Download PDF', format: 'pdf', available: pandocAvailable },
          { label: 'Download DOCX', format: 'docx', available: pandocAvailable },
        ]
      : []

  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-border"
      data-testid="proposal-toolbar"
    >
      <ArtifactStatusBadge displayStatus={displayStatus} />
      <span className="font-mono text-xs text-muted">
        {proposal ? proposal.number : `E-${estimate.id.slice(0, 8)}`}
      </span>
      <span className="flex-1" />
      <StatusActionButton status={displayStatus} transitions={transitions} />

      {/* Download dropdown */}
      {proposal ? (
        <div className="relative">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDownloadOpen((v) => !v)}
            data-testid="proposal-download-button"
          >
            Download <ChevronDown size={12} />
          </Button>
          {downloadOpen ? (
            <div className="absolute right-0 mt-1 z-10 min-w-44 bg-surface border border-border rounded-md shadow-lg p-1">
              {downloadOpts.map((opt) => (
                <a
                  key={opt.format}
                  href={opt.available ? downloadProposalUrl(proposal.id, opt.format) : undefined}
                  onClick={(e) => {
                    if (!opt.available) {
                      e.preventDefault()
                      toast.error('Pandoc not available on this machine.')
                      return
                    }
                    setDownloadOpen(false)
                  }}
                  data-testid={`proposal-download-${opt.format}`}
                  className={
                    opt.available
                      ? 'block px-2 py-1.5 text-xs rounded hover:bg-bg'
                      : 'block px-2 py-1.5 text-xs rounded opacity-50 cursor-not-allowed'
                  }
                >
                  {opt.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <Button
        variant="secondary"
        size="sm"
        onClick={() => setConfirmRevise(true)}
        data-testid="proposal-revise"
      >
        Revise
      </Button>

      <Button
        variant="secondary"
        size="sm"
        onClick={onHistoryToggle}
        data-testid="proposal-history-button"
      >
        History
      </Button>

      <AlertDialog
        open={confirmRevise}
        onOpenChange={setConfirmRevise}
        title="Revise this estimate?"
        body="A new draft will be created. The current estimate and any linked proposal remain in their current state."
        confirmLabel="Revise"
        onConfirm={() =>
          reviseEstimate.mutate(estimate.id, {
            onSuccess: (res) => {
              toast.success('New revision created.')
              onNavigate(res.estimate.id)
            },
          })
        }
      />
    </div>
  )
}

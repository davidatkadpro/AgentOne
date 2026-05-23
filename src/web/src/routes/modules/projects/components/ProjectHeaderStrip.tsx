import { Copy, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { StatusActionButton } from '@/components/module/StatusActionButton'
import type { Project, ProjectBudget, EntityStatus } from '@/types/domain'
import { ProjectStatusBadge } from './ProjectStatusBadge'

export interface ProjectHeaderStripProps {
  project: Project
  budget: ProjectBudget | null
  rootPath: string | null
  onStatusChange(status: EntityStatus): void
  onOpenInChat(): void
}

export function ProjectHeaderStrip({
  project,
  budget,
  rootPath,
  onStatusChange,
  onOpenInChat,
}: ProjectHeaderStripProps) {
  const transitions = buildStatusTransitions(project.status, onStatusChange)

  return (
    <div className="border-b border-border px-4 py-3 flex items-center gap-3 flex-wrap">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-sm text-muted">{project.number}</span>
        <h2 className="text-base font-semibold text-fg">{project.name}</h2>
        {project.client ? (
          <span className="text-xs text-muted">· {project.client}</span>
        ) : null}
      </div>
      <ProjectStatusBadge status={project.status} size="md" />
      {budget ? <BudgetChip budget={budget} /> : null}
      <div className="flex-1" />
      {rootPath ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void navigator.clipboard.writeText(rootPath)}
          title={rootPath}
        >
          <Copy size={12} /> Copy folder path
        </Button>
      ) : null}
      <Button variant="secondary" size="sm" onClick={onOpenInChat} data-testid="open-in-chat">
        <MessageSquare size={12} /> Open in chat
      </Button>
      <StatusActionButton status={project.status} transitions={transitions} />
    </div>
  )
}

function BudgetChip({ budget }: { budget: ProjectBudget }) {
  if (budget.budgetCents == null) return null
  const pct = Math.round((budget.invoicedCents / Math.max(1, budget.budgetCents)) * 100)
  const tone =
    pct > 100
      ? 'text-danger'
      : pct > 90
        ? 'text-warn'
        : 'text-emerald-600 dark:text-emerald-400'
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] ${tone} bg-surface border border-border rounded px-1.5 py-0.5`}
      title={`Invoiced ${(budget.invoicedCents / 100).toFixed(0)} of ${(budget.budgetCents / 100).toFixed(0)}`}
    >
      Budget {pct}%
    </span>
  )
}

function buildStatusTransitions(
  _current: EntityStatus,
  set: (s: EntityStatus) => void,
): Record<string, { primary: { label: string; onClick(): void }; secondary: Array<{ label: string; onClick(): void }> }> {
  // The "primary" action is the forward move along the happy path. The
  // secondary list exposes the side moves (block, cancel) and the way back.
  const blockOrCancel = [
    { label: 'Mark blocked', onClick: () => set('blocked') },
    { label: 'Cancel', onClick: () => set('cancelled') },
  ]
  return {
    pending: {
      primary: { label: 'Start project', onClick: () => set('active') },
      secondary: blockOrCancel,
    },
    active: {
      primary: { label: 'Complete project', onClick: () => set('completed') },
      secondary: [
        { label: 'Mark blocked', onClick: () => set('blocked') },
        { label: 'Move to pending', onClick: () => set('pending') },
        { label: 'Cancel', onClick: () => set('cancelled') },
      ],
    },
    blocked: {
      primary: { label: 'Resume', onClick: () => set('active') },
      secondary: [{ label: 'Cancel', onClick: () => set('cancelled') }],
    },
    completed: {
      primary: { label: 'Reopen', onClick: () => set('active') },
      secondary: [],
    },
    cancelled: {
      primary: { label: 'Reopen', onClick: () => set('active') },
      secondary: [],
    },
  }
}

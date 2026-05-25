import { useEffect, useState } from 'react'
import { Copy, MessageSquare, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Input, Textarea } from '@/components/ui/Input'
import { StatusActionButton } from '@/components/module/StatusActionButton'
import { useUpdateProject } from '@/api/projects'
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
  const [editOpen, setEditOpen] = useState(false)

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
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setEditOpen(true)}
        data-testid="project-edit"
      >
        <Pencil size={12} /> Edit
      </Button>
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
      <ProjectEditDialog project={project} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  )
}

function ProjectEditDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const update = useUpdateProject(project.id)
  const [name, setName] = useState(project.name)
  const [client, setClient] = useState(project.client ?? '')
  const [description, setDescription] = useState(project.description ?? '')

  // When the project changes (or the dialog re-opens), reset drafts to the
  // server's current values rather than carrying over a half-edited form.
  useEffect(() => {
    if (!open) return
    setName(project.name)
    setClient(project.client ?? '')
    setDescription(project.description ?? '')
  }, [open, project.id, project.name, project.client, project.description])

  function save() {
    const body: Parameters<typeof update.mutateAsync>[0] = {}
    const trimmedName = name.trim()
    if (trimmedName && trimmedName !== project.name) body.name = trimmedName
    const nextClient = client.trim() || null
    if (nextClient !== (project.client ?? null)) body.client = nextClient
    const nextDesc = description.trim() || null
    if (nextDesc !== (project.description ?? null)) body.description = nextDesc
    if (Object.keys(body).length === 0) {
      onOpenChange(false)
      return
    }
    void update.mutateAsync(body).then(() => onOpenChange(false))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Edit project ${project.number}`}>
      <div className="space-y-3">
        <label className="block">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Name</div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="project-edit-name"
          />
        </label>
        <label className="block">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Client</div>
          <Input
            value={client}
            onChange={(e) => setClient(e.target.value)}
            placeholder="(none)"
            data-testid="project-edit-client"
          />
        </label>
        <label className="block">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Description</div>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="h-28"
            placeholder="(optional)"
            data-testid="project-edit-description"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={update.isPending || !name.trim()}
            data-testid="project-edit-save"
          >
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function BudgetChip({ budget }: { budget: ProjectBudget }) {
  if (budget.budgetTotal <= 0) return null
  const pct = Math.round((budget.invoicedTotal / Math.max(1, budget.budgetTotal)) * 100)
  const tone =
    pct > 100
      ? 'text-danger'
      : pct > 90
        ? 'text-warn'
        : 'text-emerald-600 dark:text-emerald-400'
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] ${tone} bg-surface border border-border rounded px-1.5 py-0.5`}
      title={`Invoiced ${budget.invoicedTotal.toFixed(0)} of ${budget.budgetTotal.toFixed(0)}`}
      data-testid="budget-chip"
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

import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/time'
import type { Project, ProjectBudget } from '@/types/domain'
import { ProjectStatusBadge } from './ProjectStatusBadge'
import { BudgetMiniBar } from './BudgetMiniBar'

export interface ProjectListRowProps {
  project: Project
  budget: ProjectBudget | null
  lastActivity: number | null
  isActive: boolean
  onClick(): void
}

export function ProjectListRow({
  project,
  budget,
  lastActivity,
  isActive,
  onClick,
}: ProjectListRowProps) {
  return (
    <button
      data-testid={`project-row-${project.id}`}
      onClick={onClick}
      className={cn(
        'w-full text-left flex items-start gap-2 px-3 py-2 border-b border-border',
        'hover:bg-surface',
        isActive && 'bg-accent/10',
      )}
    >
      <div className="font-mono text-xs text-muted w-12 tabular-nums">{project.number}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-fg truncate">{project.name}</div>
        <div className="text-[11px] text-muted truncate">
          {project.client ?? <span className="italic">No client</span>}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <ProjectStatusBadge status={project.status} />
        {budget && budget.budgetTotal > 0 ? (
          <BudgetMiniBar
            invoicedCents={budget.invoicedTotal}
            budgetCents={budget.budgetTotal}
          />
        ) : null}
        {lastActivity ? (
          <div className="text-[10px] text-muted">{formatRelative(lastActivity)}</div>
        ) : null}
      </div>
    </button>
  )
}

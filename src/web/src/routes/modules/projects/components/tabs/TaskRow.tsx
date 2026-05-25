import { useState } from 'react'
import { ChevronDown, ChevronRight, Lock, CalendarClock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Input } from '@/components/ui/Input'
import type { EntityStatus, TaskPriority } from '@/types/domain'
import { ProjectStatusBadge } from '../ProjectStatusBadge'
import type { TaskTreeRow } from '../../hooks/useTaskTree'

export interface TaskRowProps {
  row: TaskTreeRow
  expanded: boolean
  onToggle(): void
  onSelect(): void
  onRename(title: string): void
  onStatusChange(status: EntityStatus): void
}

const STATUS_CHOICES: EntityStatus[] = ['pending', 'active', 'blocked', 'completed', 'cancelled']

export function TaskRow({
  row,
  expanded,
  onToggle,
  onSelect,
  onRename,
  onStatusChange,
}: TaskRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.title)
  const [statusOpen, setStatusOpen] = useState(false)

  function commit() {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== row.title) onRename(next)
    else setDraft(row.title)
  }

  const indentPx = row.depth * 16

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 border-b border-border text-sm',
        row.kind === 'phase' && 'bg-surface font-medium',
      )}
      style={{ paddingLeft: 12 + indentPx }}
      data-testid={row.kind === 'phase' ? `phase-row-${row.id}` : `task-row-${row.id}`}
    >
      {row.childCount > 0 || row.kind === 'phase' ? (
        <button
          onClick={onToggle}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="text-muted hover:text-fg"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      ) : (
        <span className="w-3.5" />
      )}
      <div className="flex-1 min-w-0">
        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setEditing(false)
                setDraft(row.title)
              }
            }}
            className="h-7 text-sm"
            data-testid={`row-rename-${row.id}`}
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            onDoubleClick={() => setEditing(true)}
            className={cn(
              'text-left w-full truncate hover:text-accent',
              row.status === 'completed' && 'line-through text-muted',
              row.status === 'cancelled' && 'opacity-60',
            )}
            data-testid={`row-title-${row.id}`}
          >
            {row.title}
          </button>
        )}
      </div>
      {row.task && row.task.priority !== 'normal' && row.kind === 'task' ? (
        <span
          className={cn(
            'text-[10px] px-1.5 py-0.5 rounded border',
            priorityChip(row.task.priority),
          )}
          data-testid={`row-priority-${row.id}`}
        >
          {row.task.priority}
        </span>
      ) : null}
      {row.task?.dueDate ? (
        <DueDateChip due={row.task.dueDate} status={row.status} />
      ) : null}
      {row.blockedBy.length > 0 ? (
        <span className="inline-flex items-center gap-1 text-[10px] text-warn">
          <Lock size={10} /> blocked
        </span>
      ) : null}
      <div className="relative">
        <button
          onClick={() => setStatusOpen((v) => !v)}
          aria-label="Change status"
          data-testid={`row-status-${row.id}`}
        >
          <ProjectStatusBadge status={row.status} />
        </button>
        {statusOpen ? (
          <div
            className="absolute right-0 mt-1 z-20 min-w-32 bg-surface border border-border rounded-md shadow-lg p-1"
            onMouseLeave={() => setStatusOpen(false)}
          >
            {STATUS_CHOICES.map((s) => (
              <button
                key={s}
                onClick={() => {
                  onStatusChange(s)
                  setStatusOpen(false)
                }}
                className="w-full text-left px-2 py-1 text-xs rounded hover:bg-bg"
                data-testid={`row-status-choose-${row.id}-${s}`}
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {row.kind === 'task' ? (
        <button
          onClick={onSelect}
          className="text-[10px] text-muted hover:text-fg"
          data-testid={`row-open-${row.id}`}
        >
          Open
        </button>
      ) : null}
    </div>
  )
}

function priorityChip(p: TaskPriority): string {
  switch (p) {
    case 'urgent':
      return 'border-danger bg-danger/10 text-danger'
    case 'high':
      return 'border-warn bg-warn/10 text-warn'
    case 'low':
      return 'border-border bg-surface text-muted'
    case 'normal':
      return 'border-border bg-surface text-muted'
  }
}

function DueDateChip({ due, status }: { due: number; status: EntityStatus }) {
  // Treat anything before "today at local midnight" as overdue. Completed and
  // cancelled tasks render the chip in a muted style — overdue alarms there
  // would just be noise.
  const dueDate = new Date(due)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const overdue =
    dueDate.getTime() < today.getTime() && status !== 'completed' && status !== 'cancelled'
  const label = dueDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border',
        overdue
          ? 'border-danger bg-danger/10 text-danger'
          : 'border-border bg-surface text-muted',
      )}
      data-testid={`row-due-${dueDate.toISOString().slice(0, 10)}`}
      title={dueDate.toLocaleDateString()}
    >
      <CalendarClock size={10} />
      {label}
    </span>
  )
}

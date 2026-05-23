import { useEffect, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import {
  useAddPhase,
  useAddTask,
  useUpdatePhase,
  useUpdateTask,
} from '@/api/projects'
import type { EntityStatus } from '@/types/domain'
import { useTaskTree } from '../../hooks/useTaskTree'
import { TaskRow } from './TaskRow'
import { TaskSheet } from './TaskSheet'

export interface TasksTabProps {
  projectId: string
  openTaskId: string | null
  onOpenTask(id: string | null): void
}

export function TasksTab({ projectId, openTaskId, onOpenTask }: TasksTabProps) {
  const tree = useTaskTree(projectId)
  const addPhase = useAddPhase(projectId)
  const addTask = useAddTask(projectId)
  const updateTask = useUpdateTask(projectId)
  const updatePhase = useUpdatePhase(projectId)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [phaseDraft, setPhaseDraft] = useState('')
  const [showPhaseInput, setShowPhaseInput] = useState(false)
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({})

  function toggle(id: string) {
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function isHidden(rowId: string): boolean {
    // Hide rows whose parent chain is collapsed.
    const row = tree.rows.find((r) => r.id === rowId)
    if (!row) return false
    let parentId = row.parentId
    while (parentId) {
      if (collapsed.has(parentId)) return true
      const parentRow = tree.rows.find((r) => r.id === parentId)
      parentId = parentRow?.parentId ?? null
    }
    return false
  }

  function addNewPhase() {
    if (!phaseDraft.trim()) {
      setShowPhaseInput(false)
      return
    }
    void addPhase
      .mutateAsync({ name: phaseDraft.trim() })
      .then(() => {
        setPhaseDraft('')
        setShowPhaseInput(false)
      })
      .catch(() => {
        // Error surfaces via the mutation state; leave the input open.
      })
  }

  function addNewTask(phaseId: string, parentTaskId: string | null = null) {
    const key = parentTaskId ?? phaseId
    const title = (taskDrafts[key] ?? '').trim()
    if (!title) return
    const body: Parameters<typeof addTask.mutateAsync>[0] = { phaseId, title }
    if (parentTaskId) body.parentTaskId = parentTaskId
    void addTask.mutateAsync(body).then(() => {
      setTaskDrafts((d) => ({ ...d, [key]: '' }))
    })
  }

  function renameRow(id: string, kind: 'phase' | 'task', title: string) {
    if (kind === 'phase') {
      void updatePhase.mutateAsync({ phaseId: id, body: { name: title } })
    } else {
      void updateTask.mutateAsync({ taskId: id, body: { title } })
    }
  }

  function setStatus(id: string, kind: 'phase' | 'task', status: EntityStatus) {
    if (kind === 'phase') {
      void updatePhase.mutateAsync({ phaseId: id, body: { status } })
    } else {
      void updateTask.mutateAsync({ taskId: id, body: { status } })
    }
  }

  // When openTaskId points at a task that exists, expand its ancestors so the
  // row is visible in the tree once the Sheet closes.
  useEffect(() => {
    if (!openTaskId) return
    const row = tree.rows.find((r) => r.id === openTaskId && r.kind === 'task')
    if (!row) return
    setCollapsed((c) => {
      const next = new Set(c)
      let parentId = row.parentId
      while (parentId) {
        next.delete(parentId)
        const parent = tree.rows.find((r) => r.id === parentId)
        parentId = parent?.parentId ?? null
      }
      return next
    })
  }, [openTaskId, tree.rows])

  if (tree.isLoading) {
    return <div className="p-4 text-xs text-muted">Loading tasks…</div>
  }

  return (
    <div className="flex flex-col h-full" data-testid="tasks-tab">
      <div className="flex-1 overflow-auto scrollbar-thin">
        {tree.rows.length === 0 ? (
          <div className="p-6 text-sm text-muted">
            <p className="mb-3">This project has no phases yet.</p>
            <Button size="sm" onClick={() => setShowPhaseInput(true)}>
              <Plus size={12} /> Add phase
            </Button>
          </div>
        ) : (
          tree.rows.map((row) => {
            if (isHidden(row.id)) return null
            const expanded = !collapsed.has(row.id)
            const items: ReactNode[] = [
              <TaskRow
                key={row.id}
                row={row}
                expanded={expanded}
                onToggle={() => toggle(row.id)}
                onSelect={() => onOpenTask(row.id)}
                onRename={(title) => renameRow(row.id, row.kind, title)}
                onStatusChange={(status) => setStatus(row.id, row.kind, status)}
              />,
            ]
            // Inline add-task input under each phase row when expanded.
            if (row.kind === 'phase' && expanded) {
              const key = row.id
              items.push(
                <div
                  key={`${row.id}-add`}
                  className="flex gap-1 px-3 py-1.5 border-b border-border text-xs"
                  style={{ paddingLeft: 28 }}
                >
                  <Input
                    value={taskDrafts[key] ?? ''}
                    onChange={(e) =>
                      setTaskDrafts((d) => ({ ...d, [key]: e.target.value }))
                    }
                    placeholder="New task — Enter to add"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addNewTask(row.id)
                    }}
                    className="h-7 text-xs"
                    data-testid={`add-task-input-${row.id}`}
                  />
                  <Button
                    size="sm"
                    onClick={() => addNewTask(row.id)}
                    disabled={!((taskDrafts[key] ?? '').trim().length > 0)}
                  >
                    Add
                  </Button>
                </div>,
              )
            }
            // Inline add-subtask under each task row when expanded.
            if (row.kind === 'task' && expanded && row.task) {
              const key = row.id
              items.push(
                <div
                  key={`${row.id}-add-sub`}
                  className="flex gap-1 px-3 py-1 border-b border-border text-[10px]"
                  style={{ paddingLeft: 12 + (row.depth + 1) * 16 }}
                >
                  <Input
                    value={taskDrafts[key] ?? ''}
                    onChange={(e) =>
                      setTaskDrafts((d) => ({ ...d, [key]: e.target.value }))
                    }
                    placeholder="+ subtask"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter')
                        addNewTask(row.task!.phaseId, row.task!.id)
                    }}
                    className="h-6 text-[11px]"
                    data-testid={`add-subtask-input-${row.id}`}
                  />
                </div>,
              )
            }
            return items
          })
        )}
      </div>
      <div className="border-t border-border p-2 flex items-center gap-2">
        {showPhaseInput ? (
          <>
            <Input
              autoFocus
              value={phaseDraft}
              onChange={(e) => setPhaseDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addNewPhase()
                if (e.key === 'Escape') setShowPhaseInput(false)
              }}
              placeholder="Phase name"
              className="h-7 text-xs"
              data-testid="add-phase-input"
            />
            <Button size="sm" onClick={addNewPhase}>
              Add
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setShowPhaseInput(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowPhaseInput(true)}
            data-testid="add-phase-button"
          >
            <Plus size={12} /> Add phase
          </Button>
        )}
      </div>
      <TaskSheet
        projectId={projectId}
        taskId={openTaskId ?? ''}
        open={!!openTaskId}
        onOpenChange={(open) => {
          if (!open) onOpenTask(null)
        }}
      />
    </div>
  )
}

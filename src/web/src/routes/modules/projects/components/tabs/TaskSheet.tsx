import { useEffect, useMemo, useState } from 'react'
import { Sheet } from '@/components/ui/Sheet'
import { Textarea, Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useProject, useUpdateTask, useAddDependency, useRemoveDependency } from '@/api/projects'
import type { EntityStatus, Task } from '@/types/domain'
import { ProjectStatusBadge } from '../ProjectStatusBadge'

export interface TaskSheetProps {
  projectId: string
  taskId: string
  open: boolean
  onOpenChange(open: boolean): void
}

const STATUS_CHOICES: EntityStatus[] = ['pending', 'active', 'blocked', 'completed', 'cancelled']

export function TaskSheet({ projectId, taskId, open, onOpenChange }: TaskSheetProps) {
  const detail = useProject(projectId)
  const updateTask = useUpdateTask(projectId)
  const addDep = useAddDependency(projectId)
  const removeDep = useRemoveDependency(projectId)

  const task = useMemo<Task | undefined>(
    () => detail.data?.tasks.find((t) => t.id === taskId),
    [detail.data, taskId],
  )
  const allTasks = detail.data?.tasks ?? []
  const deps = useMemo(
    () => (detail.data?.dependencies ?? []).filter((d) => d.taskId === taskId),
    [detail.data, taskId],
  )
  const blockers = useMemo(
    () => deps.map((d) => allTasks.find((t) => t.id === d.dependsOnTaskId)).filter(Boolean) as Task[],
    [deps, allTasks],
  )

  const [editingBody, setEditingBody] = useState(false)
  const [draftBody, setDraftBody] = useState('')
  const [depPicker, setDepPicker] = useState('')
  const [depError, setDepError] = useState<string | null>(null)

  useEffect(() => {
    setDraftBody(task?.description ?? '')
    setEditingBody(false)
    setDepError(null)
  }, [task?.id])

  if (!open) return null

  function saveBody() {
    if (!task) return
    void updateTask.mutateAsync({
      taskId: task.id,
      body: { description: draftBody.trim() ? draftBody : null },
    })
    setEditingBody(false)
  }

  function changeStatus(s: EntityStatus) {
    if (!task) return
    void updateTask.mutateAsync({ taskId: task.id, body: { status: s } })
  }

  function pickDependency() {
    if (!task || !depPicker) return
    setDepError(null)
    void addDep
      .mutateAsync({ taskId: task.id, body: { dependsOnTaskId: depPicker } })
      .then(() => setDepPicker(''))
      .catch((err: unknown) => {
        const msg =
          (err as { code?: string }).code === 'TASK_DEPENDENCY_CYCLE'
            ? 'Adding this dependency would create a cycle'
            : (err as Error).message || 'Failed to add dependency'
        setDepError(msg)
      })
  }

  function removeDependency(blocker: Task) {
    if (!task) return
    void removeDep.mutateAsync({ taskId: task.id, dependsOnTaskId: blocker.id })
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={task ? task.title : 'Task'}
      width="md"
    >
      {!task ? (
        <div className="text-xs text-muted">Task not found in this project.</div>
      ) : (
        <div className="space-y-4">
          <section>
            <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Status</div>
            <div className="flex flex-wrap gap-1">
              {STATUS_CHOICES.map((s) => (
                <button
                  key={s}
                  onClick={() => changeStatus(s)}
                  className="inline-flex items-center"
                  data-testid={`sheet-status-${s}`}
                >
                  <span className={task.status === s ? 'ring-2 ring-accent rounded-md' : ''}>
                    <ProjectStatusBadge status={s} size="md" />
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] uppercase tracking-wider text-muted">Description</div>
              {!editingBody ? (
                <button
                  onClick={() => setEditingBody(true)}
                  className="text-[10px] text-accent hover:underline"
                >
                  Edit
                </button>
              ) : null}
            </div>
            {editingBody ? (
              <div className="space-y-2">
                <Textarea
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  className="h-32"
                  data-testid="sheet-body-edit"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveBody}>
                    Save
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditingBody(false)
                      setDraftBody(task.description ?? '')
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-sm whitespace-pre-wrap text-fg">
                {task.description ?? <span className="italic text-muted">No description</span>}
              </div>
            )}
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
              Dependencies
            </div>
            <div className="space-y-1">
              {blockers.length === 0 ? (
                <div className="text-xs text-muted italic">No blockers</div>
              ) : (
                blockers.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center gap-2 text-xs px-2 py-1 bg-surface border border-border rounded"
                  >
                    <ProjectStatusBadge status={b.status} />
                    <span className="flex-1 truncate">{b.title}</span>
                    <button
                      onClick={() => removeDependency(b)}
                      className="text-[10px] text-muted hover:text-danger"
                      data-testid={`sheet-dep-remove-${b.id}`}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="mt-2 flex gap-1">
              <select
                value={depPicker}
                onChange={(e) => setDepPicker(e.target.value)}
                className="flex-1 h-8 rounded-md border border-border bg-bg px-2 text-xs text-fg"
                data-testid="sheet-dep-picker"
              >
                <option value="">Pick a task…</option>
                {allTasks
                  .filter(
                    (t) => t.id !== task.id && !blockers.some((b) => b.id === t.id),
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
              </select>
              <Button size="sm" onClick={pickDependency} disabled={!depPicker}>
                Add
              </Button>
            </div>
            {depError ? (
              <div className="text-xs text-danger mt-1" role="alert">
                {depError}
              </div>
            ) : null}
          </section>

          {task.assigneeProfile ? (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Assignee</div>
              <div className="text-sm">{task.assigneeProfile}</div>
            </section>
          ) : null}
          <SubtasksSummary projectId={projectId} taskId={taskId} />
          <AssigneeInline projectId={projectId} task={task} />
        </div>
      )}
    </Sheet>
  )
}

function SubtasksSummary({ projectId, taskId }: { projectId: string; taskId: string }) {
  const detail = useProject(projectId)
  const subtasks = detail.data?.tasks.filter((t) => t.parentTaskId === taskId) ?? []
  if (subtasks.length === 0) return null
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Subtasks</div>
      <ul className="space-y-1">
        {subtasks.map((s) => (
          <li key={s.id} className="text-xs flex items-center gap-2">
            <ProjectStatusBadge status={s.status} />
            <span className="truncate">{s.title}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function AssigneeInline({ projectId, task }: { projectId: string; task: Task }) {
  const updateTask = useUpdateTask(projectId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.assigneeProfile ?? '')
  if (task.assigneeProfile && !editing) return null
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Set assignee</div>
      <div className="flex gap-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="profile id (optional)"
          className="h-8 text-xs"
          data-testid="sheet-assignee-input"
        />
        <Button
          size="sm"
          onClick={() => {
            void updateTask.mutateAsync({
              taskId: task.id,
              body: { assigneeProfile: draft.trim() || null },
            })
            setEditing(false)
          }}
        >
          Save
        </Button>
      </div>
    </section>
  )
}

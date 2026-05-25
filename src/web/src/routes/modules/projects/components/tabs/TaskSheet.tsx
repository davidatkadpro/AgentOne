import { useEffect, useMemo, useState } from 'react'
import { Sheet } from '@/components/ui/Sheet'
import { Textarea, Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import {
  useAttachTaskFile,
  useDetachTaskFile,
  useProject,
  useProjectFiles,
  useUpdateTask,
  useAddDependency,
  useRemoveDependency,
} from '@/api/projects'
import type { EntityStatus, Task, TaskFile, TaskPriority } from '@/types/domain'
import { ProjectStatusBadge } from '../ProjectStatusBadge'

export interface TaskSheetProps {
  projectId: string
  taskId: string
  open: boolean
  onOpenChange(open: boolean): void
}

const STATUS_CHOICES: EntityStatus[] = ['pending', 'active', 'blocked', 'completed', 'cancelled']
const PRIORITY_CHOICES: TaskPriority[] = ['low', 'normal', 'high', 'urgent']

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
  const attachedFiles = useMemo<TaskFile[]>(
    () => (detail.data?.taskFiles ?? []).filter((f) => f.taskId === taskId),
    [detail.data, taskId],
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

  function changePriority(p: TaskPriority) {
    if (!task) return
    void updateTask.mutateAsync({ taskId: task.id, body: { priority: p } })
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
            <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Priority</div>
            <div className="flex gap-1" role="radiogroup" aria-label="Priority">
              {PRIORITY_CHOICES.map((p) => (
                <button
                  key={p}
                  role="radio"
                  aria-checked={task.priority === p}
                  onClick={() => changePriority(p)}
                  data-testid={`sheet-priority-${p}`}
                  className={
                    task.priority === p
                      ? `text-[11px] px-2 py-0.5 rounded-md border ${priorityChipClass(p)}`
                      : 'text-[11px] px-2 py-0.5 rounded-md border border-border bg-surface text-muted hover:text-fg'
                  }
                >
                  {p}
                </button>
              ))}
            </div>
          </section>

          <DateRangeEditor projectId={projectId} task={task} />
          <TimeEditor projectId={projectId} task={task} />

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

          <FilesSection projectId={projectId} taskId={task.id} files={attachedFiles} />

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

// Convert a unix-ms timestamp to a "YYYY-MM-DD" string in local time so a
// browser-native date input round-trips cleanly. Returns '' for null.
function toDateInputValue(ts: number | null): string {
  if (ts === null) return ''
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Parse a "YYYY-MM-DD" string into a unix-ms timestamp pinned to local midnight.
// Returns null when the input is empty (treated as "clear the field").
function fromDateInputValue(raw: string): number | null {
  if (!raw) return null
  const [y, m, d] = raw.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d).getTime()
}

function DateRangeEditor({ projectId, task }: { projectId: string; task: Task }) {
  const updateTask = useUpdateTask(projectId)
  const [start, setStart] = useState(toDateInputValue(task.startDate))
  const [due, setDue] = useState(toDateInputValue(task.dueDate))

  useEffect(() => {
    setStart(toDateInputValue(task.startDate))
    setDue(toDateInputValue(task.dueDate))
  }, [task.id, task.startDate, task.dueDate])

  function commitStart(raw: string) {
    setStart(raw)
    const next = fromDateInputValue(raw)
    if (next === task.startDate) return
    void updateTask.mutateAsync({ taskId: task.id, body: { startDate: next } })
  }
  function commitDue(raw: string) {
    setDue(raw)
    const next = fromDateInputValue(raw)
    if (next === task.dueDate) return
    void updateTask.mutateAsync({ taskId: task.id, body: { dueDate: next } })
  }

  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Schedule</div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <div className="text-[10px] text-muted mb-0.5">Start</div>
          <Input
            type="date"
            value={start}
            onChange={(e) => commitStart(e.target.value)}
            className="h-8 text-xs"
            data-testid="sheet-start-date"
          />
        </label>
        <label className="block">
          <div className="text-[10px] text-muted mb-0.5">Due</div>
          <Input
            type="date"
            value={due}
            onChange={(e) => commitDue(e.target.value)}
            className="h-8 text-xs"
            data-testid="sheet-due-date"
          />
        </label>
      </div>
    </section>
  )
}

function TimeEditor({ projectId, task }: { projectId: string; task: Task }) {
  const updateTask = useUpdateTask(projectId)
  const [estimated, setEstimated] = useState(
    task.estimatedMinutes === null ? '' : String(task.estimatedMinutes),
  )
  const [spent, setSpent] = useState(String(task.spentMinutes))

  useEffect(() => {
    setEstimated(task.estimatedMinutes === null ? '' : String(task.estimatedMinutes))
    setSpent(String(task.spentMinutes))
  }, [task.id, task.estimatedMinutes, task.spentMinutes])

  function commitEstimated() {
    const raw = estimated.trim()
    const next = raw === '' ? null : Math.max(0, Math.floor(Number(raw)))
    if (raw !== '' && !Number.isFinite(next)) return
    if (next === task.estimatedMinutes) return
    void updateTask.mutateAsync({ taskId: task.id, body: { estimatedMinutes: next } })
  }
  function commitSpent() {
    const raw = spent.trim()
    const next = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw)))
    if (!Number.isFinite(next)) return
    if (next === task.spentMinutes) return
    void updateTask.mutateAsync({ taskId: task.id, body: { spentMinutes: next } })
  }

  // Show ratio + over-budget warning so the operator can spot tasks running long
  // without doing the math. Hide entirely when no estimate exists.
  const overBudget =
    task.estimatedMinutes !== null && task.estimatedMinutes > 0 && task.spentMinutes > task.estimatedMinutes

  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Time (minutes)</div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <div className="text-[10px] text-muted mb-0.5">Estimated</div>
          <Input
            inputMode="numeric"
            value={estimated}
            onChange={(e) => setEstimated(e.target.value)}
            onBlur={commitEstimated}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="h-8 text-xs"
            data-testid="sheet-estimated-minutes"
            placeholder="—"
          />
        </label>
        <label className="block">
          <div className="text-[10px] text-muted mb-0.5">Spent</div>
          <Input
            inputMode="numeric"
            value={spent}
            onChange={(e) => setSpent(e.target.value)}
            onBlur={commitSpent}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className={
              overBudget
                ? 'h-8 text-xs border-warn text-warn'
                : 'h-8 text-xs'
            }
            data-testid="sheet-spent-minutes"
          />
        </label>
      </div>
      {overBudget ? (
        <div className="text-[10px] text-warn mt-1">
          Over estimate by {task.spentMinutes - (task.estimatedMinutes ?? 0)} min
        </div>
      ) : null}
    </section>
  )
}

function FilesSection({
  projectId,
  taskId,
  files,
}: {
  projectId: string
  taskId: string
  files: TaskFile[]
}) {
  const projectFiles = useProjectFiles(projectId)
  const attach = useAttachTaskFile(projectId)
  const detach = useDetachTaskFile(projectId)
  const [picker, setPicker] = useState('')
  const [label, setLabel] = useState('')

  // Only offer file (not directory) entries that aren't already attached.
  const options = useMemo(() => {
    const taken = new Set(files.map((f) => f.filePath))
    return (projectFiles.data?.entries ?? [])
      .filter((e) => e.kind === 'file' && !taken.has(e.relativePath))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }, [projectFiles.data, files])

  function add() {
    if (!picker) return
    void attach
      .mutateAsync({
        taskId,
        body: { filePath: picker, label: label.trim() || null },
      })
      .then(() => {
        setPicker('')
        setLabel('')
      })
  }

  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Linked files</div>
      <div className="space-y-1">
        {files.length === 0 ? (
          <div className="text-xs text-muted italic">No linked files</div>
        ) : (
          files.map((f) => (
            <div
              key={f.filePath}
              className="flex items-center gap-2 text-xs px-2 py-1 bg-surface border border-border rounded"
              data-testid={`sheet-file-${f.filePath}`}
            >
              <div className="flex-1 min-w-0">
                <div className="truncate font-mono text-[11px]">{f.filePath}</div>
                {f.label ? <div className="text-[10px] text-muted truncate">{f.label}</div> : null}
              </div>
              <button
                onClick={() =>
                  void detach.mutateAsync({ taskId, body: { filePath: f.filePath } })
                }
                className="text-[10px] text-muted hover:text-danger"
                data-testid={`sheet-file-remove-${f.filePath}`}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
      <div className="mt-2 space-y-1">
        <select
          value={picker}
          onChange={(e) => setPicker(e.target.value)}
          className="w-full h-8 rounded-md border border-border bg-bg px-2 text-xs text-fg"
          data-testid="sheet-file-picker"
          disabled={options.length === 0}
        >
          <option value="">
            {options.length === 0 ? 'No project files available' : 'Pick a file…'}
          </option>
          {options.map((o) => (
            <option key={o.relativePath} value={o.relativePath}>
              {o.relativePath}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="h-8 text-xs flex-1"
            data-testid="sheet-file-label"
          />
          <Button size="sm" onClick={add} disabled={!picker}>
            Attach
          </Button>
        </div>
      </div>
    </section>
  )
}

function priorityChipClass(p: TaskPriority): string {
  switch (p) {
    case 'urgent':
      return 'border-danger bg-danger/10 text-danger'
    case 'high':
      return 'border-warn bg-warn/10 text-warn'
    case 'normal':
      return 'border-accent bg-accent/10 text-accent'
    case 'low':
      return 'border-border bg-surface text-muted'
  }
}

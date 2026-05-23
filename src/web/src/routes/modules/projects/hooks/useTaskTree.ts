import { useMemo } from 'react'
import { useProject } from '@/api/projects'
import type { EntityStatus, Phase, Task, TaskDependency } from '@/types/domain'

export interface TaskTreeRow {
  kind: 'phase' | 'task'
  id: string
  parentId: string | null
  depth: number
  status: EntityStatus
  title: string
  position: number
  childCount: number
  blockedBy: string[]
  /** For 'task' rows: the underlying task. For 'phase' rows: undefined. */
  task?: Task
  /** For 'phase' rows: the phase. For 'task' rows: undefined. */
  phase?: Phase
}

export interface UseTaskTreeResult {
  rows: TaskTreeRow[]
  isLoading: boolean
  refetch(): void
}

export function useTaskTree(projectId: string): UseTaskTreeResult {
  const detail = useProject(projectId)
  const phases = detail.data?.phases ?? []
  const tasks = detail.data?.tasks ?? []
  const deps = detail.data?.dependencies ?? []

  const rows = useMemo<TaskTreeRow[]>(
    () => buildTaskTree(phases, tasks, deps),
    [phases, tasks, deps],
  )

  return { rows, isLoading: detail.isLoading, refetch: () => void detail.refetch() }
}

export function buildTaskTree(
  phases: Phase[],
  tasks: Task[],
  deps: TaskDependency[],
): TaskTreeRow[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const phaseById = new Map(phases.map((p) => [p.id, p]))
  const childrenByParent = new Map<string, Task[]>()
  for (const t of tasks) {
    const key = t.parentTaskId ?? `phase:${t.phaseId}`
    const arr = childrenByParent.get(key) ?? []
    arr.push(t)
    childrenByParent.set(key, arr)
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.position - b.position)
  }

  const blockedBy = new Map<string, string[]>()
  for (const d of deps) {
    const blocker = taskById.get(d.dependsOnTaskId)
    if (!blocker || blocker.status === 'completed') continue
    const arr = blockedBy.get(d.taskId) ?? []
    arr.push(d.dependsOnTaskId)
    blockedBy.set(d.taskId, arr)
  }

  const rows: TaskTreeRow[] = []
  const sortedPhases = [...phases].sort((a, b) => a.position - b.position)

  function pushTaskRecursive(task: Task, depth: number) {
    const children = childrenByParent.get(task.id) ?? []
    rows.push({
      kind: 'task',
      id: task.id,
      parentId: task.parentTaskId ?? task.phaseId,
      depth,
      status: task.status,
      title: task.title,
      position: task.position,
      childCount: children.length,
      blockedBy: blockedBy.get(task.id) ?? [],
      task,
    })
    for (const c of children) pushTaskRecursive(c, depth + 1)
  }

  for (const phase of sortedPhases) {
    const directTasks = childrenByParent.get(`phase:${phase.id}`) ?? []
    rows.push({
      kind: 'phase',
      id: phase.id,
      parentId: null,
      depth: 0,
      status: phase.status,
      title: phase.name,
      position: phase.position,
      childCount: directTasks.length,
      blockedBy: [],
      phase,
    })
    for (const t of directTasks) pushTaskRecursive(t, 1)
  }
  // Catch dangling tasks whose phase id doesn't match a known phase. Should be
  // rare (FK enforces consistency) but keep them visible if they appear.
  for (const t of tasks) {
    if (t.parentTaskId) continue
    if (!phaseById.has(t.phaseId)) {
      rows.push({
        kind: 'task',
        id: t.id,
        parentId: t.phaseId,
        depth: 1,
        status: t.status,
        title: t.title,
        position: t.position,
        childCount: 0,
        blockedBy: blockedBy.get(t.id) ?? [],
        task: t,
      })
    }
  }
  return rows
}

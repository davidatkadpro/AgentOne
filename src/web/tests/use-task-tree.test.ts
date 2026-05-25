import { describe, it, expect } from 'vitest'
import { buildTaskTree } from '@/routes/modules/projects/hooks/useTaskTree'
import type { Phase, Task, TaskDependency } from '@/types/domain'

function phase(id: string, position: number, name = 'p'): Phase {
  return {
    id,
    projectId: 'P',
    name,
    position,
    status: 'pending',
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
  }
}

function task(
  id: string,
  phaseId: string,
  position: number,
  opts: Partial<Task> = {},
): Task {
  return {
    id,
    projectId: 'P',
    phaseId,
    parentTaskId: null,
    title: opts.title ?? id,
    description: null,
    status: opts.status ?? 'pending',
    assigneeProfile: null,
    position,
    startDate: null,
    dueDate: null,
    estimatedMinutes: null,
    spentMinutes: 0,
    priority: 'normal',
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...opts,
  }
}

describe('buildTaskTree', () => {
  it('flattens phases + their tasks at depth 1', () => {
    const rows = buildTaskTree(
      [phase('ph1', 0, 'SD')],
      [task('t1', 'ph1', 0, { title: 'A' }), task('t2', 'ph1', 1, { title: 'B' })],
      [],
    )
    expect(rows.map((r) => `${r.kind}:${r.depth}:${r.title}`)).toEqual([
      'phase:0:SD',
      'task:1:A',
      'task:1:B',
    ])
  })

  it('nests subtasks under their parent with increasing depth', () => {
    const rows = buildTaskTree(
      [phase('ph1', 0)],
      [
        task('t1', 'ph1', 0, { title: 'parent' }),
        task('s1', 'ph1', 0, { parentTaskId: 't1', title: 'sub' }),
        task('s2', 'ph1', 0, { parentTaskId: 's1', title: 'subsub' }),
      ],
      [],
    )
    expect(rows.map((r) => `${r.depth}:${r.title}`)).toEqual([
      '0:p',
      '1:parent',
      '2:sub',
      '3:subsub',
    ])
  })

  it('sorts phases by position', () => {
    const rows = buildTaskTree(
      [phase('a', 2, 'Z'), phase('b', 0, 'A'), phase('c', 1, 'M')],
      [],
      [],
    )
    expect(rows.map((r) => r.title)).toEqual(['A', 'M', 'Z'])
  })

  it('computes blockedBy only for incomplete blockers', () => {
    const rows = buildTaskTree(
      [phase('ph', 0)],
      [
        task('a', 'ph', 0),
        task('b', 'ph', 1, { status: 'active' }),
        task('c', 'ph', 2, { status: 'completed' }),
      ],
      [
        { taskId: 'a', dependsOnTaskId: 'b' }, // active blocker counts
        { taskId: 'a', dependsOnTaskId: 'c' }, // completed blocker excluded
      ] as TaskDependency[],
    )
    const aRow = rows.find((r) => r.id === 'a')!
    expect(aRow.blockedBy).toEqual(['b'])
  })

  it('reports childCount per row', () => {
    const rows = buildTaskTree(
      [phase('ph', 0)],
      [
        task('p', 'ph', 0),
        task('s1', 'ph', 0, { parentTaskId: 'p' }),
        task('s2', 'ph', 1, { parentTaskId: 'p' }),
      ],
      [],
    )
    expect(rows.find((r) => r.id === 'ph')!.childCount).toBe(1)
    expect(rows.find((r) => r.id === 'p')!.childCount).toBe(2)
  })

  it('returns empty rows when there are no phases or tasks', () => {
    expect(buildTaskTree([], [], [])).toEqual([])
  })
})

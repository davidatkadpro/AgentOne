import { describe, it, expect, beforeEach, vi } from 'vitest'

const invalidated: unknown[][] = []

vi.mock('@/lib/query-client', () => ({
  queryClient: {
    invalidateQueries: vi.fn((opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey)
      return Promise.resolve()
    }),
  },
  queryKeys: {
    sessions: {
      list: () => ['sessions', 'list'],
      detail: (id: string) => ['sessions', 'detail', id],
    },
    profiles: { list: () => ['profiles', 'list'] },
    drafts: { list: () => ['drafts', 'list'] },
    notifications: { all: () => ['notifications'] },
    skills: { list: () => ['skills', 'list'] },
    moduleActions: { list: (m: string) => ['module-actions', m] },
    projects: {
      all: () => ['projects'],
      list: () => ['projects', 'list'],
      detail: (id: string) => ['projects', 'detail', id],
      activity: (id: string) => ['projects', 'activity', id],
    },
  },
}))
vi.mock('@/stores/ws', () => ({
  useWsStore: { getState: () => ({}) },
  subscribedSessions: () => [],
}))
vi.mock('@/stores/session-stream', () => ({
  useSessionStreamStore: { getState: () => ({ applyEvent: vi.fn(), hydrateFromDetail: vi.fn() }) },
}))
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: { getState: () => ({ applyEvent: vi.fn() }) },
}))

describe('invalidateForEvent — projects dispatch fanout', () => {
  beforeEach(() => {
    invalidated.length = 0
  })

  async function dispatch(event: unknown) {
    const ws = await import('@/lib/ws')
    ws.invalidateForEvent(event as never)
  }

  it('project.created invalidates list + detail + activity', async () => {
    await dispatch({ type: 'project.created', projectId: 'p1', number: '24001', ts: 1 })
    expect(invalidated).toEqual([
      ['projects', 'list'],
      ['projects', 'detail', 'p1'],
      ['projects', 'activity', 'p1'],
    ])
  })

  it('project.completed invalidates the same triad', async () => {
    await dispatch({ type: 'project.completed', projectId: 'p1', ts: 1 })
    expect(invalidated).toEqual([
      ['projects', 'list'],
      ['projects', 'detail', 'p1'],
      ['projects', 'activity', 'p1'],
    ])
  })

  it('phase.created invalidates detail + activity (not list)', async () => {
    await dispatch({ type: 'phase.created', projectId: 'p2', phaseId: 'ph1', ts: 1 })
    expect(invalidated).toEqual([
      ['projects', 'detail', 'p2'],
      ['projects', 'activity', 'p2'],
    ])
  })

  it('task.updated invalidates detail + activity', async () => {
    await dispatch({ type: 'task.updated', projectId: 'p3', taskId: 't1', ts: 1 })
    expect(invalidated).toEqual([
      ['projects', 'detail', 'p3'],
      ['projects', 'activity', 'p3'],
    ])
  })

  it('task.completed invalidates detail + activity', async () => {
    await dispatch({ type: 'task.completed', projectId: 'p4', taskId: 't2', ts: 1 })
    expect(invalidated).toEqual([
      ['projects', 'detail', 'p4'],
      ['projects', 'activity', 'p4'],
    ])
  })

  it('task.blocked invalidates detail + activity', async () => {
    await dispatch({
      type: 'task.blocked',
      projectId: 'p5',
      taskId: 't3',
      reason: 'waiting on client',
      ts: 1,
    })
    expect(invalidated).toEqual([
      ['projects', 'detail', 'p5'],
      ['projects', 'activity', 'p5'],
    ])
  })

  it('module.reloaded invalidates that module-actions key only', async () => {
    await dispatch({ type: 'module.reloaded', module: 'projects', ts: 1 })
    expect(invalidated).toEqual([['module-actions', 'projects']])
  })
})

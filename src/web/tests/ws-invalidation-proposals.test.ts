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
    emails: {
      all: () => ['emails'],
      detail: (id: string) => ['emails', 'detail', id],
    },
    proposals: {
      all: () => ['proposals'],
      detail: (id: string) => ['proposals', 'detail', id],
    },
    estimates: {
      detail: (id: string) => ['estimates', 'detail', id],
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
vi.mock('@/stores/email-chips', () => ({
  useEmailChipsStore: { getState: () => ({ applyEvent: vi.fn() }) },
}))

describe('invalidateForEvent — proposals dispatch fanout', () => {
  beforeEach(() => {
    invalidated.length = 0
  })

  async function dispatch(event: unknown) {
    const ws = await import('@/lib/ws')
    ws.invalidateForEvent(event as never)
  }

  it('estimate.created invalidates the proposals branch + estimate detail + project detail/activity', async () => {
    await dispatch({
      type: 'estimate.created',
      projectId: 'p1',
      estimateId: 'e1',
      ts: 1,
    })
    expect(invalidated).toEqual([
      ['proposals'],
      ['estimates', 'detail', 'e1'],
      ['projects', 'detail', 'p1'],
      ['projects', 'activity', 'p1'],
    ])
  })

  it('proposal.issued invalidates proposals + that detail + project detail/activity', async () => {
    await dispatch({
      type: 'proposal.issued',
      projectId: 'p1',
      proposalId: 'pr1',
      number: '24001-P1',
      ts: 1,
    })
    expect(invalidated).toEqual([
      ['proposals'],
      ['proposals', 'detail', 'pr1'],
      ['projects', 'detail', 'p1'],
      ['projects', 'activity', 'p1'],
    ])
  })

  it('proposal.accepted invalidates the same triad', async () => {
    await dispatch({
      type: 'proposal.accepted',
      projectId: 'p1',
      proposalId: 'pr1',
      number: '24001-P1',
      ts: 1,
    })
    expect(invalidated).toEqual([
      ['proposals'],
      ['proposals', 'detail', 'pr1'],
      ['projects', 'detail', 'p1'],
      ['projects', 'activity', 'p1'],
    ])
  })

  it('proposal.superseded fans out the same way', async () => {
    await dispatch({
      type: 'proposal.superseded',
      projectId: 'p1',
      proposalId: 'pr1',
      ts: 1,
    })
    expect(invalidated).toEqual([
      ['proposals'],
      ['proposals', 'detail', 'pr1'],
      ['projects', 'detail', 'p1'],
      ['projects', 'activity', 'p1'],
    ])
  })
})

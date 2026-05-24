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
      budget: (id: string) => ['projects', 'budget', id],
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
    estimates: { detail: (id: string) => ['estimates', 'detail', id] },
    invoices: {
      all: () => ['invoices'],
      detail: (id: string) => ['invoices', 'detail', id],
    },
    qbo: { status: () => ['qbo', 'status'] },
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

describe('invalidateForEvent — invoicing dispatch fanout', () => {
  beforeEach(() => {
    invalidated.length = 0
  })

  async function dispatch(event: unknown) {
    const ws = await import('@/lib/ws')
    ws.invalidateForEvent(event as never)
  }

  it('invoice.created invalidates list+detail+project+budget+activity', async () => {
    await dispatch({
      type: 'invoice.created',
      projectId: 'p1',
      invoiceId: 'i1',
      number: '25001-01',
      ts: 1,
    })
    expect(invalidated).toEqual([
      ['invoices'],
      ['invoices', 'detail', 'i1'],
      ['projects', 'detail', 'p1'],
      ['projects', 'budget', 'p1'],
      ['projects', 'activity', 'p1'],
    ])
  })

  it('invoice.paid invalidates the same set', async () => {
    await dispatch({
      type: 'invoice.paid',
      projectId: 'p1',
      invoiceId: 'i1',
      number: '25001-01',
      ts: 1,
    })
    expect(invalidated).toContainEqual(['invoices'])
    expect(invalidated).toContainEqual(['projects', 'budget', 'p1'])
  })

  it('payment.recorded invalidates list + detail + budget + activity', async () => {
    await dispatch({
      type: 'payment.recorded',
      projectId: 'p1',
      invoiceId: 'i1',
      paymentId: 'pay-1',
      amount: 100,
      ts: 1,
    })
    expect(invalidated).toEqual([
      ['invoices'],
      ['invoices', 'detail', 'i1'],
      ['projects', 'budget', 'p1'],
      ['projects', 'activity', 'p1'],
    ])
  })

  it('qbo.invoice_pushed invalidates invoices + qbo status', async () => {
    await dispatch({
      type: 'qbo.invoice_pushed',
      projectId: 'p1',
      invoiceId: 'i1',
      qboId: 'q-1',
      ts: 1,
    })
    expect(invalidated).toEqual([
      ['invoices'],
      ['invoices', 'detail', 'i1'],
      ['qbo', 'status'],
    ])
  })

  it('qbo.drift_detected fans out the same way', async () => {
    await dispatch({
      type: 'qbo.drift_detected',
      projectId: 'p1',
      invoiceId: 'i1',
      driftFields: ['total'],
      ts: 1,
    })
    expect(invalidated).toContainEqual(['invoices', 'detail', 'i1'])
    expect(invalidated).toContainEqual(['qbo', 'status'])
  })

  it('qbo.connected invalidates qbo status + invoices', async () => {
    await dispatch({ type: 'qbo.connected', ts: 1 })
    expect(invalidated).toEqual([['qbo', 'status'], ['invoices']])
  })

  it('qbo.disconnected invalidates qbo status + invoices', async () => {
    await dispatch({ type: 'qbo.disconnected', ts: 1 })
    expect(invalidated).toEqual([['qbo', 'status'], ['invoices']])
  })
})

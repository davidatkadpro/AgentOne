import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { createNotifications, type Notifications } from '@/modules/notifications.js'

interface Harness {
  db: Db
  notifications: Notifications
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const notifications = createNotifications(db)
  return { db, notifications }
}

function disposeHarness(h: Harness): void {
  h.db.close()
}

describe('Notifications — create and read-back', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('persists a new notification with default status="unread"', () => {
    const created = h.notifications.create({
      kind: 'attention_needed',
      title: 'Choose a project',
      body: 'The email could not be auto-matched.',
      sessionId: 'sess-1',
      module: 'modules/email',
      payload: { candidates: ['p1', 'p2'] },
    })

    expect(created.id).toBeGreaterThan(0)
    expect(created.kind).toBe('attention_needed')
    expect(created.title).toBe('Choose a project')
    expect(created.body).toBe('The email could not be auto-matched.')
    expect(created.sessionId).toBe('sess-1')
    expect(created.module).toBe('modules/email')
    expect(created.payload).toEqual({ candidates: ['p1', 'p2'] })
    expect(created.status).toBe('unread')
    expect(created.createdAt).toBeGreaterThan(0)
    expect(created.resolvedAt).toBeNull()

    const fetched = h.notifications.get(created.id)
    expect(fetched).toEqual(created)
  })
})

describe('Notifications.list', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  function seed(): { unread: number[]; read: number[] } {
    const a = h.notifications.create({ kind: 'info', title: 'A', body: '' })
    const b = h.notifications.create({ kind: 'info', title: 'B', body: '' })
    const c = h.notifications.create({ kind: 'info', title: 'C', body: '' })
    h.notifications.markRead(a.id)
    h.notifications.markRead(b.id)
    return { unread: [c.id], read: [a.id, b.id] }
  }

  it('returns all notifications newest-first when no filter is given', () => {
    const { unread, read } = seed()
    const all = h.notifications.list()
    expect(all.map((n) => n.id)).toEqual([
      unread[0],
      read[1],
      read[0],
    ])
  })

  it('filters by status when status is provided', () => {
    const { unread } = seed()
    const onlyUnread = h.notifications.list({ status: 'unread' })
    expect(onlyUnread.map((n) => n.id)).toEqual(unread)
    expect(onlyUnread.every((n) => n.status === 'unread')).toBe(true)
  })

  it('honors the limit option', () => {
    for (let i = 0; i < 5; i++) {
      h.notifications.create({ kind: 'info', title: `T${i}`, body: '' })
    }
    const top = h.notifications.list({ limit: 2 })
    expect(top).toHaveLength(2)
  })
})

describe('Notifications — lifecycle transitions', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('markRead transitions a notification from unread to read', () => {
    const n = h.notifications.create({ kind: 'info', title: 'A', body: '' })
    expect(h.notifications.get(n.id)?.status).toBe('unread')

    h.notifications.markRead(n.id)
    expect(h.notifications.get(n.id)?.status).toBe('read')
  })

  it("markRead on an already-read notification does not change its status", () => {
    const n = h.notifications.create({ kind: 'info', title: 'A', body: '' })
    h.notifications.markRead(n.id)
    h.notifications.markRead(n.id)
    expect(h.notifications.get(n.id)?.status).toBe('read')
  })

  it('resolve sets status="resolved" and a resolvedAt timestamp', () => {
    const n = h.notifications.create({ kind: 'attention_needed', title: 'A', body: '' })
    expect(h.notifications.get(n.id)?.resolvedAt).toBeNull()

    const before = Date.now()
    h.notifications.resolve(n.id)
    const after = Date.now()

    const resolved = h.notifications.get(n.id)
    expect(resolved?.status).toBe('resolved')
    expect(resolved?.resolvedAt).not.toBeNull()
    expect(resolved!.resolvedAt!).toBeGreaterThanOrEqual(before)
    expect(resolved!.resolvedAt!).toBeLessThanOrEqual(after)
  })

  it('dismiss sets status="dismissed" without setting resolvedAt', () => {
    const n = h.notifications.create({ kind: 'info', title: 'A', body: '' })
    h.notifications.dismiss(n.id)

    const dismissed = h.notifications.get(n.id)
    expect(dismissed?.status).toBe('dismissed')
    expect(dismissed?.resolvedAt).toBeNull()
  })
})

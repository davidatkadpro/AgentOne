import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { createNotifications, type Notifications } from '@/modules/notifications.js'
import { EventBus, type AgentEvent } from '@/core/events.js'

interface Harness {
  db: Db
  notifications: Notifications
  bus: EventBus
  events: AgentEvent[]
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const bus = new EventBus()
  const events: AgentEvent[] = []
  bus.onAny((e) => {
    events.push(e)
  })
  const notifications = createNotifications(db, { bus })
  return { db, notifications, bus, events }
}

describe('Notifications — bus emission', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('emits notification.created with full payload', async () => {
    h.notifications.create({
      kind: 'attention_needed',
      title: 'Q',
      body: 'ask',
      sessionId: 'sess-1',
      module: 'modules/email',
    })
    // Bus.emit is fire-and-forget but synchronous when handlers are sync.
    await new Promise((r) => setImmediate(r))
    const created = h.events.find((e) => e.type === 'notification.created')
    expect(created).toBeDefined()
    expect(created).toMatchObject({
      type: 'notification.created',
      kind: 'attention_needed',
      title: 'Q',
      body: 'ask',
      sessionId: 'sess-1',
      module: 'modules/email',
    })
  })

  it('emits notification.updated on markRead and dismiss', async () => {
    const n = h.notifications.create({ kind: 'info', title: 'x', body: 'y' })
    h.events.length = 0
    h.notifications.markRead(n.id)
    h.notifications.dismiss(n.id)
    await new Promise((r) => setImmediate(r))
    const updates = h.events.filter((e) => e.type === 'notification.updated')
    expect(updates).toHaveLength(2)
    expect(updates[0]).toMatchObject({ notificationId: n.id })
  })

  it('emits notification.resolved on resolve', async () => {
    const n = h.notifications.create({ kind: 'attention_needed', title: 'q', body: 'b' })
    h.events.length = 0
    h.notifications.resolve(n.id)
    await new Promise((r) => setImmediate(r))
    const resolved = h.events.find((e) => e.type === 'notification.resolved')
    expect(resolved).toMatchObject({ type: 'notification.resolved', notificationId: n.id })
  })

  it('still works when no bus is provided (back-compat)', () => {
    const db = createDatabase({ path: ':memory:', skipMkdir: true })
    const notifications = createNotifications(db)
    const n = notifications.create({ kind: 'info', title: 't', body: 'b' })
    expect(notifications.get(n.id)?.id).toBe(n.id)
    db.close()
  })
})

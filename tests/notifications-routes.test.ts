import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createDatabase, type Db } from '@/storage/db.js'
import { createNotifications, type Notifications } from '@/modules/notifications.js'

interface Harness {
  app: FastifyInstance
  db: Db
  notifications: Notifications
}

async function newHarness(): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const notifications = createNotifications(db)
  const app = Fastify({ logger: false })

  app.get('/api/notifications', async (req) => {
    const query = z
      .object({
        includeResolved: z.union([z.literal('true'), z.literal('false')]).optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      })
      .safeParse(req.query ?? {})
    const includeResolved = query.success && query.data.includeResolved === 'true'
    const limit = query.success ? query.data.limit ?? 100 : 100
    const all = notifications.list({ limit })
    const filtered = includeResolved
      ? all
      : all.filter((n) => n.status === 'unread' || n.status === 'read')
    return { notifications: filtered }
  })

  const NotifIdParams = z.object({ id: z.coerce.number().int().positive() })
  const UpdateBody = z.object({ status: z.enum(['read', 'resolved', 'dismissed']) })

  app.patch('/api/notifications/:id', async (req, reply) => {
    const params = NotifIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid notification id' }
    }
    const body = UpdateBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'Invalid body' }
    }
    const existing = notifications.get(params.data.id)
    if (!existing) {
      reply.code(404)
      return { error: 'Not found' }
    }
    if (body.data.status === 'read') notifications.markRead(params.data.id)
    else if (body.data.status === 'resolved') notifications.resolve(params.data.id)
    else notifications.dismiss(params.data.id)
    return { notification: notifications.get(params.data.id) }
  })

  await app.ready()
  return { app, db, notifications }
}

describe('GET /api/notifications', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await h.app.close()
    h.db.close()
  })

  it('returns unread + read notifications by default', async () => {
    h.notifications.create({ kind: 'info', title: 'one', body: 'a' })
    const two = h.notifications.create({ kind: 'info', title: 'two', body: 'b' })
    h.notifications.resolve(two.id)
    const res = await h.app.inject({ method: 'GET', url: '/api/notifications' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.notifications).toHaveLength(1)
    expect(body.notifications[0].title).toBe('one')
  })

  it('includes resolved when includeResolved=true', async () => {
    h.notifications.create({ kind: 'info', title: 'one', body: 'a' })
    const two = h.notifications.create({ kind: 'info', title: 'two', body: 'b' })
    h.notifications.resolve(two.id)
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/notifications?includeResolved=true',
    })
    const body = res.json()
    expect(body.notifications).toHaveLength(2)
  })
})

describe('PATCH /api/notifications/:id', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await h.app.close()
    h.db.close()
  })

  it('marks read', async () => {
    const n = h.notifications.create({ kind: 'info', title: 'x', body: 'y' })
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/notifications/${n.id}`,
      payload: { status: 'read' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().notification.status).toBe('read')
  })

  it('resolves and sets resolvedAt', async () => {
    const n = h.notifications.create({ kind: 'attention_needed', title: 'q', body: 'ask' })
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/notifications/${n.id}`,
      payload: { status: 'resolved' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().notification.status).toBe('resolved')
    expect(res.json().notification.resolvedAt).toBeGreaterThan(0)
  })

  it('returns 404 for missing notification', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/notifications/9999`,
      payload: { status: 'read' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 400 for malformed status', async () => {
    const n = h.notifications.create({ kind: 'info', title: 'x', body: 'y' })
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/notifications/${n.id}`,
      payload: { status: 'invalid' },
    })
    expect(res.statusCode).toBe(400)
  })
})

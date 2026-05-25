import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import { createProjectsService, type ProjectsService } from '../modules/projects/src/service.js'
import { createEmailService, type EmailService } from '../modules/email/src/service.js'
import { registerEmailRoutes } from '../modules/email/src/routes.js'
import type { EmailSource } from '../modules/email/src/source.js'

interface Harness {
  db: Db
  app: FastifyInstance
  service: EmailService
  projects: ProjectsService
  storageRoot: string
}

class FakeSource implements EmailSource {
  readonly kind = 'maildir'
  msgs: Array<Parameters<EmailService['ingestEmail']>[0]> = []
  async list(): Promise<
    Array<
      Omit<Parameters<EmailService['ingestEmail']>[0], 'metadata'> & {
        sourceKind: string
        fromName: string | null
        subject: string | null
        snippet: string | null
        hasAttachments: boolean
      }
    >
  > {
    return this.msgs.map((m) => ({
      sourceKind: m.sourceKind,
      sourceId: m.sourceId,
      receivedAt: m.receivedAt,
      fromAddress: m.fromAddress,
      fromName: m.fromName ?? null,
      subject: m.subject ?? null,
      snippet: m.snippet ?? null,
      hasAttachments: m.hasAttachments === true,
    }))
  }
  async get(): Promise<never> {
    throw new Error('unused')
  }
  async fetchAttachment(): Promise<Buffer> {
    return Buffer.alloc(0)
  }
}

async function newHarness(opts: { withSource?: boolean } = {}): Promise<{
  h: Harness
  source: FakeSource
}> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  applyAllMigrationsForModule(db, 'email')
  const storageRoot = await mkdtemp(join(tmpdir(), 'agentone-email-routes-'))
  const storage = new LocalFolderAdapter({ root: storageRoot })
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const projects = createProjectsService({ db, eventBus: bus, audit, storage })
  const service = createEmailService({ db, eventBus: bus, audit, projects, storage })
  const source = new FakeSource()
  const app = Fastify({ logger: false })
  const routesDeps: Parameters<typeof registerEmailRoutes>[1] = { service }
  if (opts.withSource) routesDeps.source = source
  await registerEmailRoutes(app, routesDeps)
  await app.ready()
  return { h: { db, app, service, projects, storageRoot }, source }
}

async function dispose(h: Harness): Promise<void> {
  await h.app.close()
  h.db.close()
  await rm(h.storageRoot, { recursive: true, force: true })
}

describe('Email routes', () => {
  let h: Harness
  let source: FakeSource
  beforeEach(async () => {
    const x = await newHarness({ withSource: true })
    h = x.h
    source = x.source
  })
  afterEach(async () => {
    await dispose(h)
  })

  function ingestOne(input?: Partial<Parameters<EmailService['ingestEmail']>[0]>): string {
    const e = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: input?.sourceId ?? 'msg-' + Math.random(),
        receivedAt: input?.receivedAt ?? Date.now(),
        fromAddress: input?.fromAddress ?? 'a@b.com',
        subject: input?.subject ?? 'hi',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    return e.id
  }

  it('GET /api/v1/email returns the list', async () => {
    ingestOne({ sourceId: 'a' })
    ingestOne({ sourceId: 'b' })
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/email' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { emails: unknown[] }
    expect(body.emails).toHaveLength(2)
  })

  it('GET /api/v1/email?isRead=false filters', async () => {
    const a = ingestOne({ sourceId: 'a' })
    ingestOne({ sourceId: 'b' })
    h.service.markRead(a, true, { actor: { type: 'user' } })
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/email?isRead=false' })
    const body = res.json() as { emails: Array<{ id: string }> }
    expect(body.emails).toHaveLength(1)
  })

  it('GET /api/v1/email/:id returns the email or 404', async () => {
    const id = ingestOne({ sourceId: 'a' })
    const found = await h.app.inject({ method: 'GET', url: `/api/v1/email/${id}` })
    expect(found.statusCode).toBe(200)
    const missing = await h.app.inject({ method: 'GET', url: '/api/v1/email/nope' })
    expect(missing.statusCode).toBe(404)
  })

  it('PATCH /api/v1/email/:id { isRead: true } marks read', async () => {
    const id = ingestOne({ sourceId: 'a' })
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/email/${id}`,
      payload: { isRead: true },
    })
    expect(res.statusCode).toBe(200)
    expect(h.service.getEmail(id)?.isRead).toBe(true)
  })

  it('PATCH /api/v1/email/:id with empty body returns 400 NO_FIELDS_TO_UPDATE', async () => {
    const id = ingestOne({ sourceId: 'a' })
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/email/${id}`,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'NO_FIELDS_TO_UPDATE' })
  })

  it('POST /api/v1/email/poll ingests new messages', async () => {
    source.msgs = [
      {
        sourceKind: 'maildir',
        sourceId: 'p1',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
      },
      {
        sourceKind: 'maildir',
        sourceId: 'p2',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
      },
    ]
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/email/poll' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ingested: 2 })
  })

  // POST /api/email/:id/file-to-project retired in P3P8 — synchronous
  // service-level behavior is covered by tests/email-file-to-project.test.ts;
  // the HTTP action-dispatch path is covered by tests/email-actions.test.ts.
})

describe('Email routes without a configured source', () => {
  let h: Harness
  beforeEach(async () => {
    const x = await newHarness({ withSource: false })
    h = x.h
  })
  afterEach(async () => {
    await dispose(h)
  })

  it('POST /api/v1/email/poll returns 503', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/email/poll' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ error: 'NO_EMAIL_SOURCE_CONFIGURED' })
  })
})

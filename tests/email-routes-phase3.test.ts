import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import { createProjectsService } from '../modules/projects/src/service.js'
import { createEmailService, type EmailService } from '../modules/email/src/service.js'
import { registerEmailRoutes } from '../modules/email/src/routes.js'
import { MaildirEmailSource } from '../modules/email/src/sources/maildir.js'

interface Harness {
  db: Db
  app: FastifyInstance
  service: EmailService
  storageRoot: string
  maildirRoot: string
}

async function newHarness(): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const projectsSql = readFileSync(
    join(process.cwd(), 'modules', 'projects', 'schema', '001_init.sql'),
    'utf-8',
  )
  applyModuleMigrations(db, 'projects', [{ version: 1, name: '001_init', sql: projectsSql }])
  const emailSql = readFileSync(
    join(process.cwd(), 'modules', 'email', 'schema', '001_init.sql'),
    'utf-8',
  )
  applyModuleMigrations(db, 'email', [{ version: 1, name: '001_init', sql: emailSql }])

  const storageRoot = await mkdtemp(join(tmpdir(), 'agentone-email-p3-'))
  const maildirRoot = await mkdtemp(join(tmpdir(), 'agentone-maildir-'))
  const storage = new LocalFolderAdapter({ root: storageRoot })
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const projects = createProjectsService({ db, eventBus: bus, audit, storage })
  const service = createEmailService({ db, eventBus: bus, audit, projects, storage })

  const source = new MaildirEmailSource({ root: maildirRoot })
  const app = Fastify({ logger: false })
  await registerEmailRoutes(app, { service, source })
  await app.ready()
  return { db, app, service, storageRoot, maildirRoot }
}

async function dispose(h: Harness): Promise<void> {
  await h.app.close()
  h.db.close()
  await rm(h.storageRoot, { recursive: true, force: true })
  await rm(h.maildirRoot, { recursive: true, force: true })
}

async function plantEml(
  root: string,
  name: string,
  opts: { html?: boolean; subject?: string; body?: string } = {},
): Promise<void> {
  const subject = opts.subject ?? 'Test subject'
  const body = opts.body ?? (opts.html ? '<p>hi</p>' : 'hello world')
  const ct = opts.html ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8'
  const raw = [
    `From: Sender <sender@example.com>`,
    `To: receiver@example.com`,
    `Subject: ${subject}`,
    `Date: Tue, 23 May 2026 10:00:00 +0000`,
    `Content-Type: ${ct}`,
    ``,
    body,
  ].join('\n')
  await writeFile(join(root, name), raw, 'utf-8')
}

describe('Email routes — Phase 3 additions', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  // ── P3P1: route aliases ──────────────────────────────────────────────────
  it('P3P1: /api/email mirrors /api/v1/email', async () => {
    await plantEml(h.maildirRoot, 'a.eml')
    await h.app.inject({ method: 'POST', url: '/api/email/poll' })
    const v1 = await h.app.inject({ method: 'GET', url: '/api/v1/email' })
    const v2 = await h.app.inject({ method: 'GET', url: '/api/email' })
    expect(v1.statusCode).toBe(200)
    expect(v2.statusCode).toBe(200)
    expect(v2.json()).toEqual(v1.json())
  })

  it('P3P1: GET /api/email/:id returns the email', async () => {
    await plantEml(h.maildirRoot, 'a.eml')
    const poll = await h.app.inject({ method: 'POST', url: '/api/email/poll' })
    expect(poll.statusCode).toBe(200)
    const list = await h.app.inject({ method: 'GET', url: '/api/email' })
    const id = (list.json() as { emails: Array<{ id: string }> }).emails[0]!.id
    const res = await h.app.inject({ method: 'GET', url: `/api/email/${id}` })
    expect(res.statusCode).toBe(200)
  })

  // ── P3P2 / P3P3: body fetch + sanitisation ───────────────────────────────
  it('P3P2: GET /api/email/:id/body returns kind:text + content for plain emails', async () => {
    await plantEml(h.maildirRoot, 'plain.eml', { body: 'hello plain' })
    await h.app.inject({ method: 'POST', url: '/api/email/poll' })
    const list = await h.app.inject({ method: 'GET', url: '/api/email' })
    const id = (list.json() as { emails: Array<{ id: string }> }).emails[0]!.id
    const res = await h.app.inject({ method: 'GET', url: `/api/email/${id}/body` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { kind: string; content: string }
    expect(body.kind).toBe('text')
    expect(body.content).toContain('hello plain')
  })

  it('P3P2 + P3P3: GET body returns sanitised HTML for text/html emails', async () => {
    await plantEml(h.maildirRoot, 'html.eml', {
      html: true,
      body: `<p>hi</p><script>alert('x')</script><a href="javascript:bad()">no</a>`,
    })
    await h.app.inject({ method: 'POST', url: '/api/email/poll' })
    const list = await h.app.inject({ method: 'GET', url: '/api/email' })
    const id = (list.json() as { emails: Array<{ id: string }> }).emails[0]!.id
    const res = await h.app.inject({ method: 'GET', url: `/api/email/${id}/body` })
    const body = res.json() as { kind: string; content: string }
    expect(body.kind).toBe('html')
    expect(body.content).toContain('<p>hi</p>')
    expect(body.content).not.toContain('script')
    expect(body.content).not.toContain('javascript:')
  })

  it('P3P2: GET body returns 404 for unknown email', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/email/nope/body' })
    expect(res.statusCode).toBe(404)
  })

  // ── P3P4: attachments ────────────────────────────────────────────────────
  it('P3P4: GET /api/email/:id/attachments/:name returns 404 from Maildir source (no attachments)', async () => {
    await plantEml(h.maildirRoot, 'a.eml')
    await h.app.inject({ method: 'POST', url: '/api/email/poll' })
    const list = await h.app.inject({ method: 'GET', url: '/api/email' })
    const id = (list.json() as { emails: Array<{ id: string }> }).emails[0]!.id
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/email/${id}/attachments/anything.pdf`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('P3P4: attachments rejects path traversal attempts', async () => {
    await plantEml(h.maildirRoot, 'a.eml')
    await h.app.inject({ method: 'POST', url: '/api/email/poll' })
    const list = await h.app.inject({ method: 'GET', url: '/api/email' })
    const id = (list.json() as { emails: Array<{ id: string }> }).emails[0]!.id
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/email/${id}/attachments/..%2Fetc%2Fpasswd`,
    })
    expect([400, 404]).toContain(res.statusCode)
  })

  // ── /poll alias ─────────────────────────────────────────────────────────
  it('POST /api/email/poll ingests new .eml files via the canonical path', async () => {
    await plantEml(h.maildirRoot, 'msg1.eml')
    await plantEml(h.maildirRoot, 'msg2.eml')
    const res = await h.app.inject({ method: 'POST', url: '/api/email/poll' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ingested: 2 })
  })

  // ── quoted-printable + base64 decoding ───────────────────────────────────
  it('decodes quoted-printable bodies', async () => {
    const raw = [
      'From: a@b.com',
      'Subject: qp',
      'Date: Tue, 23 May 2026 10:00:00 +0000',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'caf=C3=A9 caf=C3=A9',
    ].join('\n')
    await writeFile(join(h.maildirRoot, 'qp.eml'), raw, 'utf-8')
    await h.app.inject({ method: 'POST', url: '/api/email/poll' })
    const list = await h.app.inject({ method: 'GET', url: '/api/email' })
    const id = (list.json() as { emails: Array<{ id: string }> }).emails[0]!.id
    const body = await h.app.inject({ method: 'GET', url: `/api/email/${id}/body` })
    expect((body.json() as { content: string }).content).toContain('café')
  })

  // ── PATCH read works at canonical path ──────────────────────────────────
  it('PATCH /api/email/:id marks read via canonical path', async () => {
    await plantEml(h.maildirRoot, 'a.eml')
    await h.app.inject({ method: 'POST', url: '/api/email/poll' })
    const list = await h.app.inject({ method: 'GET', url: '/api/email' })
    const id = (list.json() as { emails: Array<{ id: string }> }).emails[0]!.id
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/email/${id}`,
      payload: { isRead: true },
    })
    expect(res.statusCode).toBe(200)
    expect(h.service.getEmail(id)?.isRead).toBe(true)
  })
})

// Avoid TS unused-import errors for cross-platform mkdir helper.
void mkdir

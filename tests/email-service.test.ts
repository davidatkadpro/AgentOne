import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog, type AuditLog } from '@/modules/audit-log.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import { createEmailService, type EmailService } from '../modules/email/src/service.js'

interface Harness {
  db: Db
  bus: EventBus
  audit: AuditLog
  service: EmailService
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  // Email depends on projects (filed_project_id REFERENCES project(id)).
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
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const service = createEmailService({ db, eventBus: bus, audit })
  return { db, bus, audit, service }
}

function disposeHarness(h: Harness): void {
  h.db.close()
}

describe('EmailService.ingestEmail — tracer', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('inserts an email row with defaults and returns it', () => {
    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-001',
        receivedAt: 1_700_000_000_000,
        fromAddress: 'client@example.com',
        fromName: 'Riverside Owner',
        subject: 'RFI: bathroom fixtures',
        snippet: 'Hi — quick question about the proposed fixture set...',
        hasAttachments: true,
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )

    expect(email.id).toBeTruthy()
    expect(email.sourceKind).toBe('maildir')
    expect(email.sourceId).toBe('msg-001')
    expect(email.receivedAt).toBe(1_700_000_000_000)
    expect(email.fromAddress).toBe('client@example.com')
    expect(email.fromName).toBe('Riverside Owner')
    expect(email.subject).toBe('RFI: bathroom fixtures')
    expect(email.snippet).toBe('Hi — quick question about the proposed fixture set...')
    expect(email.hasAttachments).toBe(true)
    expect(email.isRead).toBe(false)
    expect(email.filedProjectId).toBeNull()
    expect(email.filedFolderPath).toBeNull()
    expect(email.filedAt).toBeNull()
    expect(email.metadata).toEqual({})
    expect(email.createdAt).toBeGreaterThan(0)

    const fetched = h.service.getEmail(email.id)
    expect(fetched).toEqual(email)
  })

  it('records an audit row and emits email.received', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('email.received', (e) => {
      captured.push(e)
    })

    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-002',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    await new Promise((r) => setImmediate(r))

    const entries = h.audit.listByEntity('email', email.id)
    expect(entries).toHaveLength(1)
    expect(entries[0].action).toBe('email.received')
    expect(entries[0].module).toBe('email')
    expect(entries[0].actor).toEqual({ type: 'scheduler', id: 'test-poll' })

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      type: 'email.received',
      emailId: email.id,
      sourceKind: 'maildir',
      sourceId: 'msg-002',
    })
  })

  it('returns existing row when re-ingesting the same source ref (idempotent)', () => {
    const first = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-003',
        receivedAt: 1_700_000_000_000,
        fromAddress: 'a@b.com',
        subject: 'Original',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    const second = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-003',
        receivedAt: 1_700_000_000_000,
        fromAddress: 'a@b.com',
        subject: 'Original',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    expect(second.id).toBe(first.id)
  })
})

describe('EmailService.listEmails', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  function seedMany(): { unreadIds: string[]; readIds: string[] } {
    const unreadIds: string[] = []
    const readIds: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const e = h.service.ingestEmail(
        {
          sourceKind: 'maildir',
          sourceId: `unread-${i}`,
          receivedAt: 1_700_000_000_000 + i * 1000,
          fromAddress: 'sender@example.com',
        },
        { actor: { type: 'scheduler', id: 'test-poll' } },
      )
      unreadIds.push(e.id)
    }
    for (let i = 0; i < 2; i += 1) {
      const e = h.service.ingestEmail(
        {
          sourceKind: 'maildir',
          sourceId: `read-${i}`,
          receivedAt: 1_700_000_010_000 + i * 1000,
          fromAddress: 'sender@example.com',
        },
        { actor: { type: 'scheduler', id: 'test-poll' } },
      )
      h.service.markRead(e.id, true, { actor: { type: 'user' } })
      readIds.push(e.id)
    }
    return { unreadIds, readIds }
  }

  it('orders results by received_at DESC', () => {
    seedMany()
    const list = h.service.listEmails()
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i - 1].receivedAt).toBeGreaterThanOrEqual(list[i].receivedAt)
    }
  })

  it('filters by is_read=false', () => {
    const { unreadIds } = seedMany()
    const list = h.service.listEmails({ isRead: false })
    expect(list).toHaveLength(unreadIds.length)
    for (const e of list) expect(e.isRead).toBe(false)
  })

  it('filters by filed=true', () => {
    const { unreadIds } = seedMany()
    // File the first unread email to a project.
    h.db.prepare(
      `INSERT INTO project (id, number, name, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
    ).run('proj-1', '24001', 'Riverside', Date.now(), Date.now())
    h.service.markFiled(unreadIds[0], 'proj-1', 'projects/24001 - Riverside/in/250523 - rfi', {
      actor: { type: 'user' },
    })

    const filed = h.service.listEmails({ filed: true })
    expect(filed).toHaveLength(1)
    expect(filed[0].filedProjectId).toBe('proj-1')

    const unfiled = h.service.listEmails({ filed: false })
    expect(unfiled.every((e) => e.filedProjectId === null)).toBe(true)
  })
})

describe('EmailService.markRead', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('sets is_read=true and emits email.read on transition', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('email.read', (e) => {
      captured.push(e)
    })

    const e = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'x',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    h.service.markRead(e.id, true, { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))

    expect(h.service.getEmail(e.id)?.isRead).toBe(true)
    expect(captured).toHaveLength(1)
  })

  it('does not re-emit email.read if state is unchanged', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('email.read', (e) => {
      captured.push(e)
    })

    const e = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'y',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    h.service.markRead(e.id, true, { actor: { type: 'user' } })
    h.service.markRead(e.id, true, { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))

    expect(captured).toHaveLength(1)
  })

  it('throws on unknown id', () => {
    expect(() =>
      h.service.markRead('missing', true, { actor: { type: 'user' } }),
    ).toThrow(/not found/i)
  })
})

describe('EmailService.pollSource', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('ingests new summaries and reports the new count', async () => {
    const fake = {
      kind: 'maildir',
      async list() {
        return [
          {
            sourceKind: 'maildir',
            sourceId: 'a.eml',
            receivedAt: 1_700_000_000_000,
            fromAddress: 'a@b.com',
            fromName: null,
            subject: 's1',
            snippet: null,
            hasAttachments: false,
          },
          {
            sourceKind: 'maildir',
            sourceId: 'b.eml',
            receivedAt: 1_700_000_001_000,
            fromAddress: 'a@b.com',
            fromName: null,
            subject: 's2',
            snippet: null,
            hasAttachments: false,
          },
        ]
      },
      async get() {
        throw new Error('unused')
      },
      async fetchAttachment() {
        throw new Error('unused')
      },
    }
    const first = await h.service.pollSource(fake, { actor: { type: 'scheduler', id: 'test-poll' } })
    expect(first.ingested).toBe(2)
    expect(h.service.listEmails()).toHaveLength(2)

    // Second poll is idempotent — no new ingests.
    const second = await h.service.pollSource(fake, { actor: { type: 'scheduler', id: 'test-poll' } })
    expect(second.ingested).toBe(0)
    expect(h.service.listEmails()).toHaveLength(2)
  })
})

describe('EmailService.markFiled', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it('links the email to a project and emits email.filed', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('email.filed', (e) => {
      captured.push(e)
    })

    h.db.prepare(
      `INSERT INTO project (id, number, name, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
    ).run('proj-1', '24001', 'Riverside', Date.now(), Date.now())

    const e = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'z',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    h.service.markFiled(e.id, 'proj-1', 'projects/24001 - Riverside/in/250523 - rfi', {
      actor: { type: 'user' },
    })
    await new Promise((r) => setImmediate(r))

    const fetched = h.service.getEmail(e.id)
    expect(fetched?.filedProjectId).toBe('proj-1')
    expect(fetched?.filedFolderPath).toBe('projects/24001 - Riverside/in/250523 - rfi')
    expect(fetched?.filedAt).toBeGreaterThan(0)
    expect(captured).toHaveLength(1)
  })

  it('throws on unknown project (FK violation)', () => {
    const e = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'w',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    expect(() =>
      h.service.markFiled(e.id, 'nonexistent-project', 'whatever', { actor: { type: 'user' } }),
    ).toThrow()
  })
})

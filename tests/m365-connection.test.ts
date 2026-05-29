import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
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
  applyAllMigrationsForModule(db, 'projects')
  applyAllMigrationsForModule(db, 'email')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const service = createEmailService({ db, eventBus: bus, audit })
  return { db, bus, audit, service }
}

const USER = { actor: { type: 'user' as const } }

describe('EmailService — Microsoft 365 connection ops', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('returns null when no connection exists', () => {
    expect(h.service.getM365Connection()).toBeNull()
  })

  it('upserts a connection, audits m365.connect, and emits m365.connected', () => {
    const events: AgentEvent[] = []
    h.bus.onAny((e) => { events.push(e) })

    const conn = h.service.upsertM365Connection(
      {
        accountName: 'Riverside Studio',
        accountEmail: 'studio@knowles.example',
        accessTokenEncrypted: Buffer.from('enc-access'),
        refreshTokenEncrypted: Buffer.from('enc-refresh'),
        tokenExpiresAt: 1_900_000_000_000,
      },
      USER,
    )

    expect(conn.accountEmail).toBe('studio@knowles.example')
    expect(conn.accessTokenEncrypted.equals(Buffer.from('enc-access'))).toBe(true)
    expect(conn.lastError).toBeNull()

    const stored = h.service.getM365Connection()
    expect(stored?.accountName).toBe('Riverside Studio')

    const audit = h.audit.listByEntity('m365_connection', 'm365')
    expect(audit.map((a) => a.action)).toContain('m365.connect')
    // Tokens must never leak into the audit payload.
    expect(JSON.stringify(audit)).not.toContain('enc-access')
    expect(JSON.stringify(audit)).not.toContain('enc-refresh')

    expect(events.some((e) => e.type === 'm365.connected')).toBe(true)
  })

  it('re-upsert replaces tokens and clears a prior error (single row)', () => {
    h.service.upsertM365Connection(
      {
        accountName: 'A',
        accountEmail: 'a@example',
        accessTokenEncrypted: Buffer.from('a1'),
        refreshTokenEncrypted: Buffer.from('r1'),
        tokenExpiresAt: 1,
      },
      USER,
    )
    h.service.recordM365Error({ code: 'GRAPH_ERROR', message: 'boom' })
    expect(h.service.getM365Connection()?.lastError?.code).toBe('GRAPH_ERROR')

    h.service.upsertM365Connection(
      {
        accountName: 'B',
        accountEmail: 'b@example',
        accessTokenEncrypted: Buffer.from('a2'),
        refreshTokenEncrypted: Buffer.from('r2'),
        tokenExpiresAt: 2,
      },
      USER,
    )
    const after = h.service.getM365Connection()
    expect(after?.accountName).toBe('B')
    expect(after?.accessTokenEncrypted.equals(Buffer.from('a2'))).toBe(true)
    expect(after?.lastError).toBeNull()
    // Still exactly one row.
    const count = (h.db.prepare('SELECT COUNT(*) AS n FROM m365_connection').get() as { n: number }).n
    expect(count).toBe(1)
  })

  it('recordM365PollTs and recordM365Error update the row', () => {
    h.service.upsertM365Connection(
      {
        accountName: null,
        accountEmail: null,
        accessTokenEncrypted: Buffer.from('a'),
        refreshTokenEncrypted: Buffer.from('r'),
        tokenExpiresAt: 1,
      },
      USER,
    )
    h.service.recordM365PollTs(1_750_000_000_000)
    h.service.recordM365Error({ code: 'GRAPH_ERROR', message: 'rate limited' })
    const conn = h.service.getM365Connection()
    expect(conn?.lastPollAt).toBe(1_750_000_000_000)
    expect(conn?.lastError).toMatchObject({ code: 'GRAPH_ERROR', message: 'rate limited' })
    expect(typeof conn?.lastError?.at).toBe('number')
  })

  it('clear removes the connection, audits m365.disconnect, and emits m365.disconnected', () => {
    h.service.upsertM365Connection(
      {
        accountName: 'X',
        accountEmail: 'x@example',
        accessTokenEncrypted: Buffer.from('a'),
        refreshTokenEncrypted: Buffer.from('r'),
        tokenExpiresAt: 1,
      },
      USER,
    )
    const events: AgentEvent[] = []
    h.bus.onAny((e) => { events.push(e) })

    h.service.clearM365Connection(USER)
    expect(h.service.getM365Connection()).toBeNull()
    expect(h.audit.listByEntity('m365_connection', 'm365').map((a) => a.action)).toContain(
      'm365.disconnect',
    )
    expect(events.some((e) => e.type === 'm365.disconnected')).toBe(true)
  })

  it('clearing when nothing is connected is a no-op (no audit, no event)', () => {
    const events: AgentEvent[] = []
    h.bus.onAny((e) => { events.push(e) })
    h.service.clearM365Connection(USER)
    expect(h.audit.listByEntity('m365_connection', 'm365')).toHaveLength(0)
    expect(events.some((e) => e.type === 'm365.disconnected')).toBe(false)
  })
})

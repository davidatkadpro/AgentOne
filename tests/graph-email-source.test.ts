import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import { createSecretVault, type SecretVault } from '@/storage/secret-vault.js'
import { createEmailService, type EmailService } from '../modules/email/src/service.js'
import {
  GraphEmailSource,
  GraphEmailPoller,
  createGraphAuth,
  M365NotConnectedError,
} from '../modules/email/src/sources/graph.js'
import type {
  GraphHttpClient,
  GraphMessageSummary,
  GraphMessageDetail,
  GraphAttachmentMeta,
  GraphTokenSet,
} from '@/modules/m365/source.js'

// ── A controllable fake Graph client ────────────────────────────────────────
class FakeGraphClient implements GraphHttpClient {
  refreshCalls = 0
  markReadCalls: Array<{ id: string; isRead: boolean }> = []
  nextTokens: GraphTokenSet = {
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresIn: 3600,
  }
  messages: GraphMessageDetail[] = []
  attachments: Record<string, GraphAttachmentMeta[]> = {}
  attachmentBytes: Record<string, Buffer> = {}
  refreshShouldFail = false

  async exchangeCode(): Promise<GraphTokenSet> {
    return this.nextTokens
  }
  async refreshTokens(): Promise<GraphTokenSet> {
    this.refreshCalls += 1
    if (this.refreshShouldFail) throw new Error('invalid_grant')
    return this.nextTokens
  }
  async me() {
    return { displayName: 'Test User', mail: 'test@example.com', userPrincipalName: 'test@example.com' }
  }
  async listMessages(): Promise<GraphMessageSummary[]> {
    return this.messages.map(({ body: _body, ...s }) => s)
  }
  async getMessage(_token: string, id: string): Promise<GraphMessageDetail | null> {
    return this.messages.find((m) => m.id === id) ?? null
  }
  async listAttachments(_token: string, id: string): Promise<GraphAttachmentMeta[]> {
    return this.attachments[id] ?? []
  }
  async getAttachmentContent(_t: string, _id: string, attId: string): Promise<Buffer> {
    const buf = this.attachmentBytes[attId]
    if (!buf) throw new Error('Graph attachment not found')
    return buf
  }
  async markRead(_token: string, id: string, isRead: boolean): Promise<void> {
    this.markReadCalls.push({ id, isRead })
  }
}

interface Harness {
  db: Db
  service: EmailService
  vault: SecretVault
  client: FakeGraphClient
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  applyAllMigrationsForModule(db, 'email')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const service = createEmailService({ db, eventBus: bus, audit })
  const vault = createSecretVault({ forceBackend: 'aes-gcm', env: { QBO_TOKEN_KEY: 'unit-test-key' } })
  const client = new FakeGraphClient()
  return { db, service, vault, client }
}

const USER = { actor: { type: 'user' as const } }

function connect(h: Harness, expiresAt: number, access = 'access-1', refresh = 'refresh-1'): void {
  h.service.upsertM365Connection(
    {
      accountName: 'Test User',
      accountEmail: 'test@example.com',
      accessTokenEncrypted: h.vault.encrypt(access),
      refreshTokenEncrypted: h.vault.encrypt(refresh),
      tokenExpiresAt: expiresAt,
    },
    USER,
  )
}

describe('createGraphAuth — token lifecycle', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => h.db.close())

  it('throws M365NotConnectedError when no connection exists', async () => {
    const auth = createGraphAuth({ service: h.service, vault: h.vault, client: h.client })
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(M365NotConnectedError)
  })

  it('returns the stored access token when not near expiry', async () => {
    const now = () => 1_000_000
    connect(h, 1_000_000 + 10 * 60_000) // 10 min out
    const auth = createGraphAuth({ service: h.service, vault: h.vault, client: h.client, now })
    expect(await auth.getAccessToken()).toBe('access-1')
    expect(h.client.refreshCalls).toBe(0)
  })

  it('refreshes, re-encrypts, and persists when expired', async () => {
    const now = () => 2_000_000
    connect(h, 2_000_000 - 1000) // already expired
    const auth = createGraphAuth({ service: h.service, vault: h.vault, client: h.client, now })
    expect(await auth.getAccessToken()).toBe('access-2')
    expect(h.client.refreshCalls).toBe(1)
    // Persisted rotation: stored tokens now decrypt to the refreshed pair.
    const conn = h.service.getM365Connection()!
    expect(h.vault.decrypt(conn.accessTokenEncrypted)).toBe('access-2')
    expect(h.vault.decrypt(conn.refreshTokenEncrypted)).toBe('refresh-2')
    expect(conn.tokenExpiresAt).toBe(2_000_000 + 3600 * 1000)
    // Account label is preserved across the rotation.
    expect(conn.accountEmail).toBe('test@example.com')
  })

  it('refreshes within the skew window even if not strictly expired', async () => {
    const now = () => 5_000_000
    connect(h, 5_000_000 + 30_000) // 30s out, inside the 60s default skew
    const auth = createGraphAuth({ service: h.service, vault: h.vault, client: h.client, now })
    expect(await auth.getAccessToken()).toBe('access-2')
    expect(h.client.refreshCalls).toBe(1)
  })

  it('throws M365NotConnectedError when refresh fails', async () => {
    const now = () => 2_000_000
    connect(h, 2_000_000 - 1000)
    h.client.refreshShouldFail = true
    const auth = createGraphAuth({ service: h.service, vault: h.vault, client: h.client, now })
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(M365NotConnectedError)
  })
})

describe('GraphEmailSource', () => {
  let h: Harness
  let source: GraphEmailSource
  beforeEach(() => {
    h = newHarness()
    connect(h, Date.now() + 3_600_000)
    const auth = createGraphAuth({ service: h.service, vault: h.vault, client: h.client })
    source = new GraphEmailSource({ client: h.client, auth })
    h.client.messages = [
      {
        id: 'AAA',
        receivedDateTime: '2026-05-20T10:00:00Z',
        subject: 'Hello there',
        bodyPreview: 'preview text',
        fromName: 'Alice',
        fromAddress: 'alice@example.com',
        hasAttachments: true,
        isRead: false,
        body: { contentType: 'html', content: '<p>Hi <b>Bob</b></p><script>alert(1)</script>' },
      },
    ]
    h.client.attachments = {
      AAA: [{ id: 'att-1', name: 'plan.pdf', size: 1234, contentType: 'application/pdf' }],
    }
    h.client.attachmentBytes = { 'att-1': Buffer.from('PDFDATA') }
  })
  afterEach(() => h.db.close())

  it('list maps Graph summaries into SourceEmailSummary', async () => {
    const out = await source.list()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      sourceKind: 'graph',
      sourceId: 'AAA',
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      subject: 'Hello there',
      snippet: 'preview text',
      hasAttachments: true,
    })
    expect(out[0]!.receivedAt).toBe(Date.parse('2026-05-20T10:00:00Z'))
  })

  it('get returns detail with attachment names and a plain-text body', async () => {
    const d = await source.get('AAA')
    expect(d.attachmentNames).toEqual(['plan.pdf'])
    // HTML body is flattened to plain text for .body (getBody renders HTML).
    expect(d.body).toContain('Hi')
    expect(d.body).toContain('Bob')
    expect(d.body).not.toContain('<')
  })

  it('getBody sanitises HTML and lists attachments', async () => {
    const b = await source.getBody('AAA')
    expect(b.kind).toBe('html')
    expect(b.content).toContain('Hi')
    expect(b.content).not.toContain('alert(') // <script> stripped
    expect(b.attachments).toEqual([
      { filename: 'plan.pdf', bytes: 1234, contentType: 'application/pdf' },
    ])
  })

  it('fetchAttachment resolves a name to its Graph id and returns bytes', async () => {
    const buf = await source.fetchAttachment('AAA', 'plan.pdf')
    expect(buf.toString()).toBe('PDFDATA')
  })

  it('fetchAttachment throws when the name is unknown', async () => {
    await expect(source.fetchAttachment('AAA', 'nope.pdf')).rejects.toThrow(/not found/i)
  })

  it('markRead propagates to the Graph client', async () => {
    await source.markRead('AAA', true)
    expect(h.client.markReadCalls).toEqual([{ id: 'AAA', isRead: true }])
  })

  it('does not implement watch (poller-driven freshness)', () => {
    expect((source as { watch?: unknown }).watch).toBeUndefined()
  })
})

describe('GraphEmailPoller', () => {
  let h: Harness
  afterEach(() => h.db.close())

  it('skips quietly when disconnected (no error recorded)', async () => {
    h = newHarness()
    const auth = createGraphAuth({ service: h.service, vault: h.vault, client: h.client })
    const source = new GraphEmailSource({ client: h.client, auth })
    const poller = new GraphEmailPoller({ service: h.service, source })
    await poller.runOnce()
    expect(h.service.getM365Connection()).toBeNull()
  })

  it('ingests new messages and records last_poll_at on success', async () => {
    h = newHarness()
    connect(h, Date.now() + 3_600_000)
    const auth = createGraphAuth({ service: h.service, vault: h.vault, client: h.client })
    const source = new GraphEmailSource({ client: h.client, auth })
    h.client.messages = [
      {
        id: 'M1',
        receivedDateTime: '2026-05-21T09:00:00Z',
        subject: 'New RFI',
        bodyPreview: 'question',
        fromName: 'Carol',
        fromAddress: 'carol@example.com',
        hasAttachments: false,
        isRead: false,
        body: { contentType: 'text', content: 'plain body' },
      },
    ]
    const poller = new GraphEmailPoller({ service: h.service, source, now: () => 1_750_000_111_000 })
    await poller.runOnce()
    expect(h.service.getEmailBySourceRef('graph', 'M1')).toBeDefined()
    expect(h.service.getM365Connection()?.lastPollAt).toBe(1_750_000_111_000)
  })

  it('records an error when the source throws a non-auth failure', async () => {
    h = newHarness()
    connect(h, Date.now() + 3_600_000)
    const auth = createGraphAuth({ service: h.service, vault: h.vault, client: h.client })
    const source = new GraphEmailSource({ client: h.client, auth })
    // Make list() blow up with a non-auth error.
    h.client.listMessages = async () => {
      throw new Error('429 Too Many Requests')
    }
    const poller = new GraphEmailPoller({ service: h.service, source })
    await poller.runOnce()
    expect(h.service.getM365Connection()?.lastError?.code).toBe('GRAPH_ERROR')
    expect(h.service.getM365Connection()?.lastError?.message).toContain('429')
  })
})

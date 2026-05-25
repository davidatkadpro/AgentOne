import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import { createSecretVault } from '@/storage/secret-vault.js'
import { detectDrift, buildSnapshots } from '@/modules/qbo/pull.js'
import type { QboHttpClient, QboInvoiceDoc } from '@/modules/qbo/source.js'
import { QboPoller } from '@/modules/qbo/poller.js'
import {
  createProjectsService,
  type ProjectsService,
} from '../modules/projects/src/service.js'
import {
  createProposalsService,
  type ProposalsService,
} from '../modules/proposals/src/service.js'
import {
  createInvoicingService,
  type Invoice,
  type InvoicingService,
} from '../modules/invoicing/src/service.js'

function aLocal(): Invoice {
  return {
    id: 'inv-1',
    projectId: 'p-1',
    proposalId: null,
    number: '25001-01',
    status: 'issued',
    subtotal: 1000,
    taxAmount: 0,
    total: 1000,
    amountPaid: 0,
    dueDate: null,
    notes: null,
    qboId: 'q-1',
    qboDocNumber: '25001-01',
    syncStatus: 'synced',
    lastSyncedAt: null,
    lastError: null,
    previousInvoiceId: null,
    qboPullSnapshot: null,
    driftFields: [],
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
    issuedAt: null,
    paidAt: null,
    lines: [
      {
        id: 'l-1',
        invoiceId: 'inv-1',
        kind: 'fixed',
        description: 'Phase 1',
        qty: 1,
        unit: null,
        unitPrice: 1000,
        lineTotal: 1000,
        position: 0,
        metadata: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  }
}

function aRemote(): QboInvoiceDoc {
  return {
    Id: 'q-1',
    DocNumber: '25001-01',
    TotalAmt: 1000,
    Balance: 1000,
    Line: [{ description: 'Phase 1', amount: 1000 }],
  }
}

describe('detectDrift', () => {
  it('returns [] when local and remote match', () => {
    expect(detectDrift(aLocal(), aRemote())).toEqual([])
  })
  it('flags `total` when QBO has a different total', () => {
    const remote = aRemote()
    remote.TotalAmt = 1500
    expect(detectDrift(aLocal(), remote)).toContain('total')
  })
  it('flags `number` when DocNumber differs', () => {
    const remote = aRemote()
    remote.DocNumber = 'ZZZ'
    expect(detectDrift(aLocal(), remote)).toContain('number')
  })
  it('flags lineCount when line counts diverge', () => {
    const remote = aRemote()
    remote.Line = [...remote.Line, { description: 'extra', amount: 50 }]
    const out = detectDrift(aLocal(), remote)
    expect(out).toContain('lineCount')
  })
  it('flags lines[i].description when matched-index lines diverge', () => {
    const remote = aRemote()
    remote.Line = [{ description: 'Changed', amount: 1000 }]
    expect(detectDrift(aLocal(), remote)).toContain('lines[0].description')
  })
  it('ignores tiny rounding noise on money fields', () => {
    const remote = aRemote()
    remote.TotalAmt = 1000.001
    expect(detectDrift(aLocal(), remote)).not.toContain('total')
  })
})

describe('buildSnapshots', () => {
  it('projects each diverging field into local/qbo maps', () => {
    const local = aLocal()
    const remote = aRemote()
    remote.TotalAmt = 1500
    const drift = detectDrift(local, remote)
    const snap = buildSnapshots(local, remote, drift)
    expect(snap.local.total).toBe(1000)
    expect(snap.qbo.total).toBe(1500)
  })
  it('renders line-level paths with the right side values', () => {
    const local = aLocal()
    const remote = aRemote()
    remote.Line = [{ description: 'X', amount: 1000 }]
    const drift = detectDrift(local, remote)
    const snap = buildSnapshots(local, remote, drift)
    expect(snap.local['lines[0].description']).toBe('Phase 1')
    expect(snap.qbo['lines[0].description']).toBe('X')
  })
})

interface PollerHarness {
  db: Db
  invoicing: InvoicingService
  projects: ProjectsService
  proposals: ProposalsService
  audit: ReturnType<typeof createAuditLog>
  client: QboHttpClient & {
    fetched: Map<string, QboInvoiceDoc>
    getCalls: Array<string>
  }
  poller: QboPoller
}

function makePollerHarness(): PollerHarness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  for (const mod of ['projects', 'proposals', 'invoicing']) {
    applyAllMigrationsForModule(db, mod)
  }
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const projects = createProjectsService({ db, eventBus: bus, audit })
  const proposals = createProposalsService({ db, eventBus: bus, audit })
  const invoicing = createInvoicingService({ db, eventBus: bus, audit, projects, proposals })
  const fetched = new Map<string, QboInvoiceDoc>()
  const getCalls: string[] = []
  const client: PollerHarness['client'] = {
    fetched,
    getCalls,
    async createInvoice() {
      throw new Error('not used')
    },
    async updateInvoice() {
      throw new Error('not used')
    },
    async getInvoice(_auth, qboId) {
      getCalls.push(qboId)
      return fetched.get(qboId) ?? null
    },
    async exchangeCode() {
      throw new Error('not used')
    },
    async refreshTokens() {
      throw new Error('not used')
    },
    async revoke() {},
    async companyInfo() {
      return null
    },
  }
  const vault = createSecretVault({
    forceBackend: 'aes-gcm',
    env: { QBO_TOKEN_KEY: 'poller-key' } as NodeJS.ProcessEnv,
  })
  const poller = new QboPoller({ service: invoicing, client, vault, intervalMs: 60_000 })
  return { db, invoicing, projects, proposals, audit, client, poller }
}

describe('QboPoller', () => {
  let h: PollerHarness
  beforeEach(() => {
    h = makePollerHarness()
  })
  afterEach(() => {
    h.poller.stop()
    h.db.close()
  })

  it('skips silently when there is no connection', async () => {
    await h.poller.runOnce()
    expect(h.client.getCalls.length).toBe(0)
  })

  it('skips silently when the token has expired', async () => {
    const vault = createSecretVault({
      forceBackend: 'aes-gcm',
      env: { QBO_TOKEN_KEY: 'poller-key' } as NodeJS.ProcessEnv,
    })
    h.invoicing.upsertQboConnection(
      {
        realmId: 'r1',
        companyName: 'X',
        accessTokenEncrypted: vault.encrypt('access'),
        refreshTokenEncrypted: vault.encrypt('refresh'),
        tokenExpiresAt: 1, // way in the past
      },
      { actor: { type: 'user' } },
    )
    await h.poller.runOnce()
    expect(h.client.getCalls.length).toBe(0)
  })

  it('pulls + flags drift for each invoice with a qbo_id', async () => {
    const vault = createSecretVault({
      forceBackend: 'aes-gcm',
      env: { QBO_TOKEN_KEY: 'poller-key' } as NodeJS.ProcessEnv,
    })
    const project = h.projects.createProject(
      { number: '25001', name: 'P' },
      { actor: { type: 'user' } },
    )
    const inv = h.invoicing.createInvoice(
      { projectId: project.id, lines: [{ description: 'a', qty: 1, unitPrice: 100 }] },
      { actor: { type: 'user' } },
    )
    h.invoicing.setInvoiceStatus(inv.id, 'issued', { actor: { type: 'user' } })
    h.invoicing.markPushed(inv.id, { qboId: 'q-X', qboDocNumber: 'q-doc' })
    h.invoicing.upsertQboConnection(
      {
        realmId: 'r1',
        companyName: 'X',
        accessTokenEncrypted: vault.encrypt('access'),
        refreshTokenEncrypted: vault.encrypt('refresh'),
        tokenExpiresAt: Date.now() + 60_000,
      },
      { actor: { type: 'user' } },
    )
    // Use this vault for the poller too
    const poller = new QboPoller({
      service: h.invoicing,
      client: h.client,
      vault,
    })

    // QBO doc has a different total → drift on `total`.
    h.client.fetched.set('q-X', {
      Id: 'q-X',
      DocNumber: 'q-doc',
      TotalAmt: 9999,
      Balance: 9999,
      Line: [{ description: 'a', amount: 100 }],
    })
    await poller.runOnce()
    const refreshed = h.invoicing.getInvoice(inv.id)
    expect(refreshed?.syncStatus).toBe('drift')
    expect(refreshed?.driftFields).toContain('total')
    // Scheduled pulls must produce an audit trail — before B1 the poller
    // called the primitive without auditing, leaving the Activity tab blank
    // for everything the scheduler did.
    const entries = h.audit.listByEntity('invoice', inv.id)
    const pullEntry = entries.find((e) => e.action === 'invoice.pull')
    expect(pullEntry).toBeTruthy()
    expect(pullEntry?.actor).toEqual({ type: 'scheduler', id: 'qbo-poller' })
    poller.stop()
  })
})

// Keep vi import alive for future helpers.
void vi

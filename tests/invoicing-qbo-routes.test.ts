import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import { createSecretVault, type SecretVault } from '@/storage/secret-vault.js'
import { createOAuthStateStore } from '@/modules/qbo/oauth-state.js'
import type { QboHttpClient, QboInvoiceDoc } from '@/modules/qbo/source.js'
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
  type InvoicingService,
} from '../modules/invoicing/src/service.js'
import { registerInvoicingRoutes } from '../modules/invoicing/src/routes.js'

interface Harness {
  db: Db
  app: FastifyInstance
  bus: EventBus
  projects: ProjectsService
  proposals: ProposalsService
  invoicing: InvoicingService
  vault: SecretVault
  client: ReturnType<typeof makeFakeQbo>
  events: AgentEvent[]
}

function makeFakeQbo() {
  const created: QboInvoiceDoc[] = []
  const updated: QboInvoiceDoc[] = []
  const fetched = new Map<string, QboInvoiceDoc>()
  const tokenCalls: Array<{ kind: 'exchange' | 'refresh' | 'revoke'; arg: string }> = []
  const client: QboHttpClient & { __seed(doc: QboInvoiceDoc): void } = {
    __seed(doc) {
      fetched.set(doc.Id, doc)
    },
    async createInvoice(_auth, doc) {
      const full: QboInvoiceDoc = { ...doc, Id: `qbo-${created.length + 1}` }
      created.push(full)
      fetched.set(full.Id, full)
      return full
    },
    async updateInvoice(_auth, doc) {
      updated.push(doc)
      fetched.set(doc.Id, doc)
      return doc
    },
    async getInvoice(_auth, qboId) {
      return fetched.get(qboId) ?? null
    },
    async exchangeCode(code) {
      tokenCalls.push({ kind: 'exchange', arg: code })
      return {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 3600,
        realmId: 'realm-999',
      }
    },
    async refreshTokens(refreshToken) {
      tokenCalls.push({ kind: 'refresh', arg: refreshToken })
      return {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresIn: 3600,
      }
    },
    async revoke(token) {
      tokenCalls.push({ kind: 'revoke', arg: token })
    },
    async companyInfo() {
      return { CompanyName: 'Acme LLC' }
    },
  }
  return Object.assign(client, { created, updated, tokenCalls, fetched })
}

async function newHarness(opts: { withQbo: boolean } = { withQbo: true }): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  for (const mod of ['projects', 'proposals', 'invoicing']) {
    applyAllMigrationsForModule(db, mod)
  }
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const events: AgentEvent[] = []
  bus.onAny((e) => {
    events.push(e)
  })
  const projects = createProjectsService({ db, eventBus: bus, audit })
  const proposals = createProposalsService({ db, eventBus: bus, audit })
  const invoicing = createInvoicingService({
    db,
    eventBus: bus,
    audit,
    projects,
    proposals,
  })
  const vault = createSecretVault({
    forceBackend: 'aes-gcm',
    env: { QBO_TOKEN_KEY: 'phase-5-test' } as NodeJS.ProcessEnv,
  })
  const client = makeFakeQbo()
  const oauthState = createOAuthStateStore()
  const app = Fastify({ logger: false })
  const deps: Parameters<typeof registerInvoicingRoutes>[1] = {
    service: invoicing,
    audit,
    eventBus: bus,
  }
  if (opts.withQbo) {
    deps.qbo = {
      client,
      vault,
      oauthState,
      clientId: 'test-client',
      clientSecret: 'test-secret',
      redirectUri: 'http://127.0.0.1/api/integrations/qbo/callback',
      authorizeUrl: 'https://example.test/oauth',
      spaCallbackUrl: '/settings?tab=integrations',
    }
  }
  await registerInvoicingRoutes(app, deps)
  await app.ready()
  return { db, app, bus, projects, proposals, invoicing, vault, client, events }
}

function makeProject(h: Harness): string {
  return h.projects.createProject(
    { number: '25001', name: 'Riverside' },
    { actor: { type: 'user' } },
  ).id
}

function makeIssuedInvoice(h: Harness, projectId: string): string {
  const inv = h.invoicing.createInvoice(
    {
      projectId,
      lines: [{ description: 'Phase A', qty: 1, unitPrice: 5000 }],
    },
    { actor: { type: 'user' } },
  )
  h.invoicing.setInvoiceStatus(inv.id, 'issued', { actor: { type: 'user' } })
  return inv.id
}

function setConnection(h: Harness, expiresInMs = 3600_000): void {
  h.invoicing.upsertQboConnection(
    {
      realmId: 'realm-test',
      companyName: 'Test Co',
      accessTokenEncrypted: h.vault.encrypt('access-existing'),
      refreshTokenEncrypted: h.vault.encrypt('refresh-existing'),
      tokenExpiresAt: Date.now() + expiresInMs,
    },
    { actor: { type: 'user' } },
  )
}

describe('Invoicing QBO routes', () => {
  let h: Harness

  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await h.app.close()
    h.db.close()
  })

  it('GET /api/invoicing/qbo/status returns connected:false when no row', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/invoicing/qbo/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ connected: false })
  })

  it('GET /api/invoicing/qbo/status returns full envelope when connected', async () => {
    setConnection(h)
    const res = await h.app.inject({ method: 'GET', url: '/api/invoicing/qbo/status' })
    const body = res.json() as { connected: boolean; realmId?: string; companyName?: string }
    expect(body.connected).toBe(true)
    expect(body.realmId).toBe('realm-test')
    expect(body.companyName).toBe('Test Co')
  })

  it('GET /api/integrations/qbo/connect 302s to QBO with state', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/connect',
    })
    expect(res.statusCode).toBe(302)
    const loc = res.headers['location'] as string
    expect(loc).toContain('https://example.test/oauth?')
    expect(loc).toMatch(/state=/)
    expect(loc).toContain('client_id=test-client')
  })

  it('GET /api/integrations/qbo/callback rejects bad state', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/callback?code=abc&realmId=xyz&state=wrong',
    })
    expect(res.statusCode).toBe(302)
    expect((res.headers['location'] as string)).toContain('qbo=error')
    expect((res.headers['location'] as string)).toContain('bad_state')
  })

  it('GET /api/integrations/qbo/callback exchanges code + persists encrypted tokens', async () => {
    // Mint a valid state first.
    const connectRes = await h.app.inject({
      method: 'GET',
      url: '/api/integrations/qbo/connect',
    })
    const loc = connectRes.headers['location'] as string
    const state = new URL(loc).searchParams.get('state') as string

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/integrations/qbo/callback?code=auth-code&realmId=realm-from-cb&state=${state}`,
    })
    expect(res.statusCode).toBe(302)
    expect((res.headers['location'] as string)).toContain('qbo=connected')

    const conn = h.invoicing.getQboConnection()
    expect(conn).not.toBeNull()
    expect(conn?.realmId).toBe('realm-999') // from fake exchangeCode override
    expect(conn?.companyName).toBe('Acme LLC')
    // Stored tokens are encrypted — decoding via the vault should produce the
    // values the fake handed back.
    expect(h.vault.decrypt(conn!.accessTokenEncrypted)).toBe('access-1')
    expect(h.vault.decrypt(conn!.refreshTokenEncrypted)).toBe('refresh-1')

    const connEvt = h.events.find((e) => e.type === 'qbo.connected')
    expect(connEvt).toBeDefined()
  })

  it('POST /api/integrations/qbo/disconnect clears the connection row', async () => {
    setConnection(h)
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/disconnect',
    })
    expect(res.statusCode).toBe(200)
    expect(h.invoicing.getQboConnection()).toBeNull()
    const evt = h.events.find((e) => e.type === 'qbo.disconnected')
    expect(evt).toBeDefined()
  })

  it('POST disconnect 404s when no connection', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/integrations/qbo/disconnect',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'NOT_CONNECTED' })
  })

  it('POST /api/invoicing/invoices/:id/push 409s INVOICE_NOT_ISSUED on draft', async () => {
    setConnection(h)
    const projectId = makeProject(h)
    const inv = h.invoicing.createInvoice(
      { projectId, lines: [{ description: 'x', qty: 1, unitPrice: 100 }] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${inv.id}/push`,
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'INVOICE_NOT_ISSUED' })
  })

  it('POST push 409 NOT_CONNECTED when no qbo_connection', async () => {
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'NOT_CONNECTED' })
  })

  it('POST push sets sync_status=synced + qboId on success', async () => {
    setConnection(h)
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { qboId: string; syncStatus: string; invoice: { qboId: string } }
    expect(body.syncStatus).toBe('synced')
    expect(body.qboId).toBe('qbo-1')
    expect(body.invoice.qboId).toBe('qbo-1')
    const evt = h.events.find(
      (e): e is AgentEvent & { type: 'qbo.invoice_pushed' } =>
        e.type === 'qbo.invoice_pushed',
    )
    expect(evt?.invoiceId).toBe(invoiceId)
  })

  it('POST pull 404 NOT_PUSHED when invoice has no qboId', async () => {
    setConnection(h)
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/pull`,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'NOT_PUSHED' })
  })

  it('POST pull clears drift when QBO matches local', async () => {
    setConnection(h)
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    // Push first to populate qboId.
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/pull`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ syncStatus: 'synced' })
  })

  it('POST pull flags drift when QBO has a different total', async () => {
    setConnection(h)
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    // Mutate the QBO copy so drift detection trips.
    const local = h.invoicing.getInvoice(invoiceId)
    expect(local?.qboId).toBe('qbo-1')
    const remote = h.client.fetched.get('qbo-1') as QboInvoiceDoc
    remote.TotalAmt = 999999
    h.client.fetched.set('qbo-1', remote)

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/pull`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { syncStatus: string; driftFields?: string[] }
    expect(body.syncStatus).toBe('drift')
    expect(body.driftFields).toContain('total')
    const refreshed = h.invoicing.getInvoice(invoiceId)
    expect(refreshed?.syncStatus).toBe('drift')
    expect(refreshed?.driftFields).toContain('total')
  })

  it('POST reconcile keep_local pushes back and clears drift', async () => {
    setConnection(h)
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    // Force into drift.
    const remote = h.client.fetched.get('qbo-1') as QboInvoiceDoc
    remote.TotalAmt = 999999
    h.client.fetched.set('qbo-1', remote)
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/pull`,
    })
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/reconcile`,
      payload: { strategy: 'keep_local' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      syncStatus: 'synced',
      resolution: 'keep_local',
    })
    const refreshed = h.invoicing.getInvoice(invoiceId)
    expect(refreshed?.syncStatus).toBe('synced')
    expect(refreshed?.driftFields).toEqual([])
  })

  it('POST reconcile accept_qbo clears drift without pushing', async () => {
    setConnection(h)
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    const remote = h.client.fetched.get('qbo-1') as QboInvoiceDoc
    remote.TotalAmt = 999999
    h.client.fetched.set('qbo-1', remote)
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/pull`,
    })
    const beforeUpdates = h.client.updated.length
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/reconcile`,
      payload: { strategy: 'accept_qbo' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ resolution: 'accept_qbo' })
    expect(h.client.updated.length).toBe(beforeUpdates)
  })

  it('POST reconcile merge requires merged payload', async () => {
    setConnection(h)
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    const remote = h.client.fetched.get('qbo-1') as QboInvoiceDoc
    remote.TotalAmt = 999999
    h.client.fetched.set('qbo-1', remote)
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/pull`,
    })
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/reconcile`,
      payload: { strategy: 'merge' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: 'INVALID_MERGE' })
  })

  it('POST reconcile 409s NOT_IN_DRIFT when invoice is clean', async () => {
    setConnection(h)
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/reconcile`,
      payload: { strategy: 'keep_local' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'NOT_IN_DRIFT' })
  })

  it('returns 503 QBO_NOT_CONFIGURED when QBO is not wired', async () => {
    await h.app.close()
    h.db.close()
    h = await newHarness({ withQbo: false })
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ error: 'QBO_NOT_CONFIGURED' })
  })

  it('refreshes tokens when access token has expired', async () => {
    setConnection(h, -1000) // already expired
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(h.client.tokenCalls.some((c) => c.kind === 'refresh')).toBe(true)
    const conn = h.invoicing.getQboConnection()
    expect(h.vault.decrypt(conn!.accessTokenEncrypted)).toBe('access-2')
  })
})

describe('Invoicing cross-project list', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness({ withQbo: false })
  })
  afterEach(async () => {
    await h.app.close()
    h.db.close()
  })

  it('GET /api/invoicing/invoices returns all invoices when no filter', async () => {
    const p1 = makeProject(h)
    const p2 = h.projects.createProject(
      { number: '25002', name: 'Other' },
      { actor: { type: 'user' } },
    ).id
    h.invoicing.createInvoice(
      { projectId: p1, lines: [{ description: 'x', qty: 1, unitPrice: 10 }] },
      { actor: { type: 'user' } },
    )
    h.invoicing.createInvoice(
      { projectId: p2, lines: [{ description: 'y', qty: 1, unitPrice: 20 }] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({ method: 'GET', url: '/api/invoicing/invoices' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { invoices: Array<{ projectId: string }> }
    expect(body.invoices.length).toBe(2)
  })

  it('filters by projectId', async () => {
    const p1 = makeProject(h)
    const p2 = h.projects.createProject(
      { number: '25002', name: 'Other' },
      { actor: { type: 'user' } },
    ).id
    h.invoicing.createInvoice(
      { projectId: p1, lines: [{ description: 'x', qty: 1, unitPrice: 10 }] },
      { actor: { type: 'user' } },
    )
    h.invoicing.createInvoice(
      { projectId: p2, lines: [{ description: 'y', qty: 1, unitPrice: 20 }] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/invoicing/invoices?projectId=${p1}`,
    })
    const body = res.json() as { invoices: Array<{ projectId: string }> }
    expect(body.invoices.length).toBe(1)
    expect(body.invoices[0]?.projectId).toBe(p1)
  })

  it('PATCH /api/invoicing/invoices/:id updates lines and totals', async () => {
    const projectId = makeProject(h)
    const inv = h.invoicing.createInvoice(
      { projectId, lines: [{ description: 'one', qty: 1, unitPrice: 100 }] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/invoicing/invoices/${inv.id}`,
      payload: {
        lines: [
          { description: 'a', qty: 2, unitPrice: 50 },
          { description: 'b', qty: 1, unitPrice: 200 },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { invoice: { subtotal: number; total: number; lines: unknown[] } }
    expect(body.invoice.subtotal).toBe(300)
    expect(body.invoice.total).toBe(300)
    expect(body.invoice.lines.length).toBe(2)
  })

  it('GET /api/invoicing/invoices/:id surfaces drift payload when in drift', async () => {
    await h.app.close()
    h.db.close()
    h = await newHarness({ withQbo: true })
    setConnection(h)
    const projectId = makeProject(h)
    const invoiceId = makeIssuedInvoice(h, projectId)
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/push`,
      payload: {},
    })
    const remote = h.client.fetched.get('qbo-1') as QboInvoiceDoc
    remote.TotalAmt = 999999
    h.client.fetched.set('qbo-1', remote)
    await h.app.inject({
      method: 'POST',
      url: `/api/invoicing/invoices/${invoiceId}/pull`,
    })
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/invoicing/invoices/${invoiceId}`,
    })
    const body = res.json() as { drift: { driftFields: string[] } | null }
    expect(body.drift).not.toBeNull()
    expect(body.drift?.driftFields).toContain('total')
  })
})

// Keep the vi import live for future test cases.
void vi

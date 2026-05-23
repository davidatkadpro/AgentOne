import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
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
  projects: ProjectsService
  proposals: ProposalsService
  invoicing: InvoicingService
}

async function newHarness(): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  for (const mod of ['projects', 'proposals', 'invoicing']) {
    applyModuleMigrations(db, mod, [
      {
        version: 1,
        name: '001_init',
        sql: readFileSync(
          join(process.cwd(), 'modules', mod, 'schema', '001_init.sql'),
          'utf-8',
        ),
      },
    ])
  }
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const projects = createProjectsService({ db, eventBus: bus, audit })
  const proposals = createProposalsService({ db, eventBus: bus, audit })
  const invoicing = createInvoicingService({
    db,
    eventBus: bus,
    audit,
    projects,
    proposals,
  })
  const app = Fastify({ logger: false })
  await registerInvoicingRoutes(app, { service: invoicing })
  await app.ready()
  return { db, app, projects, proposals, invoicing }
}

async function dispose(h: Harness): Promise<void> {
  await h.app.close()
  h.db.close()
}

describe('Invoicing routes', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  function makeProject(): string {
    return h.projects.createProject(
      { number: '25001', name: 'Riverside' },
      { actor: { type: 'user' } },
    ).id
  }

  it('POST /api/v1/projects/:id/invoices returns 201 with a numbered invoice', async () => {
    const projectId = makeProject()
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/invoices`,
      payload: {
        lines: [{ description: 'x', qty: 1, unitPrice: 1000 }],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { invoice: { number: string; total: number } }
    expect(body.invoice.number).toBe('25001-01')
    expect(body.invoice.total).toBe(1000)
  })

  it('GET /api/v1/projects/:id/invoices lists rows', async () => {
    const projectId = makeProject()
    h.invoicing.createInvoice(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/invoices`,
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { invoices: unknown[] }).invoices).toHaveLength(1)
  })

  it('GET /api/v1/projects/:id/budget returns budget rollup', async () => {
    const projectId = makeProject()
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/budget`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      budget: { budgetTotal: 0, invoicedTotal: 0, paidTotal: 0 },
    })
  })

  it('POST /api/v1/invoices/:id/payments records a payment and returns updated invoice', async () => {
    const projectId = makeProject()
    const inv = h.invoicing.createInvoice(
      { projectId, lines: [{ description: 'x', qty: 1, unitPrice: 100 }] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${inv.id}/payments`,
      payload: { amount: 60, method: 'check', reference: '1234' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { payment: { amount: number }; invoice: { status: string } }
    expect(body.payment.amount).toBe(60)
    expect(body.invoice.status).toBe('partial')
  })

  it('PATCH /api/v1/invoices/:id/status to "issued" works', async () => {
    const projectId = makeProject()
    const inv = h.invoicing.createInvoice(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/invoices/${inv.id}/status`,
      payload: { status: 'issued' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { invoice: { status: string } }
    expect(body.invoice.status).toBe('issued')
  })

  it('GET /api/v1/invoices/:id returns invoice + payments', async () => {
    const projectId = makeProject()
    const inv = h.invoicing.createInvoice(
      { projectId, lines: [{ description: 'x', qty: 1, unitPrice: 100 }] },
      { actor: { type: 'user' } },
    )
    h.invoicing.recordPayment(
      { invoiceId: inv.id, amount: 20 },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/invoices/${inv.id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { invoice: { id: string }; payments: unknown[] }
    expect(body.invoice.id).toBe(inv.id)
    expect(body.payments).toHaveLength(1)
  })

  it('GET /api/v1/invoices/:id returns 404 on unknown', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/invoices/nope' })
    expect(res.statusCode).toBe(404)
  })
})

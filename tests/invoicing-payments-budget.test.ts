import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
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

interface Harness {
  db: Db
  bus: EventBus
  projects: ProjectsService
  proposals: ProposalsService
  invoicing: InvoicingService
}

function newHarness(): Harness {
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
  return { db, bus, projects, proposals, invoicing }
}

function makeProject(h: Harness): { id: string; number: string } {
  const p = h.projects.createProject(
    { number: '25001', name: 'Riverside' },
    { actor: { type: 'user' } },
  )
  return { id: p.id, number: p.number }
}

describe('InvoicingService.recordPayment', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('transitions issued → partial on a partial payment, then → paid when reaching total', async () => {
    const project = makeProject(h)
    const inv = h.invoicing.createInvoice(
      {
        projectId: project.id,
        lines: [{ description: 'x', qty: 1, unitPrice: 1000 }],
      },
      { actor: { type: 'user' } },
    )
    h.invoicing.setInvoiceStatus(inv.id, 'issued', { actor: { type: 'user' } })

    h.invoicing.recordPayment(
      { invoiceId: inv.id, amount: 400 },
      { actor: { type: 'user' } },
    )
    let refetched = h.invoicing.getInvoice(inv.id)!
    expect(refetched.status).toBe('partial')
    expect(refetched.amountPaid).toBe(400)
    expect(refetched.paidAt).toBeNull()

    h.invoicing.recordPayment(
      { invoiceId: inv.id, amount: 600 },
      { actor: { type: 'user' } },
    )
    refetched = h.invoicing.getInvoice(inv.id)!
    expect(refetched.status).toBe('paid')
    expect(refetched.amountPaid).toBe(1000)
    expect(refetched.paidAt).toBeGreaterThan(0)
  })

  it('emits payment.recorded each time and invoice.paid once on the closing payment', async () => {
    const captured: AgentEvent[] = []
    h.bus.onAny((e) => {
      if (e.type === 'payment.recorded' || e.type === 'invoice.paid') {
        captured.push(e)
      }
    })
    const project = makeProject(h)
    const inv = h.invoicing.createInvoice(
      {
        projectId: project.id,
        lines: [{ description: 'x', qty: 1, unitPrice: 100 }],
      },
      { actor: { type: 'user' } },
    )
    h.invoicing.recordPayment(
      { invoiceId: inv.id, amount: 50 },
      { actor: { type: 'user' } },
    )
    h.invoicing.recordPayment(
      { invoiceId: inv.id, amount: 50 },
      { actor: { type: 'user' } },
    )
    await new Promise((r) => setImmediate(r))
    expect(captured.filter((e) => e.type === 'payment.recorded')).toHaveLength(2)
    expect(captured.filter((e) => e.type === 'invoice.paid')).toHaveLength(1)
  })

  it('throws on payment to a voided invoice', () => {
    const project = makeProject(h)
    const inv = h.invoicing.createInvoice(
      { projectId: project.id, lines: [{ description: 'x', qty: 1, unitPrice: 100 }] },
      { actor: { type: 'user' } },
    )
    h.invoicing.setInvoiceStatus(inv.id, 'void', { actor: { type: 'user' } })
    expect(() =>
      h.invoicing.recordPayment(
        { invoiceId: inv.id, amount: 10 },
        { actor: { type: 'user' } },
      ),
    ).toThrow(/voided/i)
  })

  it('throws on non-positive amount', () => {
    const project = makeProject(h)
    const inv = h.invoicing.createInvoice(
      { projectId: project.id, lines: [] },
      { actor: { type: 'user' } },
    )
    expect(() =>
      h.invoicing.recordPayment(
        { invoiceId: inv.id, amount: 0 },
        { actor: { type: 'user' } },
      ),
    ).toThrow(/positive/i)
  })

  it('listPayments returns payments in received_at desc order', () => {
    const project = makeProject(h)
    const inv = h.invoicing.createInvoice(
      { projectId: project.id, lines: [{ description: 'x', qty: 1, unitPrice: 1000 }] },
      { actor: { type: 'user' } },
    )
    h.invoicing.recordPayment(
      { invoiceId: inv.id, amount: 100, receivedAt: 1_700_000_000_000 },
      { actor: { type: 'user' } },
    )
    h.invoicing.recordPayment(
      { invoiceId: inv.id, amount: 200, receivedAt: 1_700_000_005_000 },
      { actor: { type: 'user' } },
    )
    const list = h.invoicing.listPayments(inv.id)
    expect(list).toHaveLength(2)
    expect(list[0].amount).toBe(200)
    expect(list[1].amount).toBe(100)
  })
})

describe('InvoicingService.setInvoiceStatus', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('issued stamps issued_at and emits invoice.issued', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('invoice.issued', (e) => {
      captured.push(e)
    })
    const project = makeProject(h)
    const inv = h.invoicing.createInvoice(
      { projectId: project.id, lines: [] },
      { actor: { type: 'user' } },
    )
    h.invoicing.setInvoiceStatus(inv.id, 'issued', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))
    const refetched = h.invoicing.getInvoice(inv.id)!
    expect(refetched.status).toBe('issued')
    expect(refetched.issuedAt).toBeGreaterThan(0)
    expect(captured).toHaveLength(1)
  })

  it('void emits invoice.voided', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('invoice.voided', (e) => {
      captured.push(e)
    })
    const project = makeProject(h)
    const inv = h.invoicing.createInvoice(
      { projectId: project.id, lines: [] },
      { actor: { type: 'user' } },
    )
    h.invoicing.setInvoiceStatus(inv.id, 'void', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))
    expect(captured).toHaveLength(1)
  })
})

describe('InvoicingService.createInvoiceFromProposal', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('copies the estimate lines into the new invoice', () => {
    const project = makeProject(h)
    const estimate = h.proposals.createEstimate(
      {
        projectId: project.id,
        lines: [
          { kind: 'fixed', description: 'plans', qty: 1, unitPrice: 4500 },
          { kind: 'time_and_materials', description: 'hrs', qty: 8, unit: 'hr', unitPrice: 165 },
        ],
      },
      { actor: { type: 'user' } },
    )
    // We can't easily call createProposal here without storage; insert
    // directly via the same schema instead.
    h.db.prepare(
      `INSERT INTO proposal (id, project_id, estimate_id, number, status, template_name,
                             metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', 'default', '{}', ?, ?)`,
    ).run('prop-1', project.id, estimate.id, '25001-P1', Date.now(), Date.now())
    const invoice = h.invoicing.createInvoiceFromProposal(
      { projectId: project.id, proposalId: 'prop-1' },
      { actor: { type: 'user' } },
    )
    expect(invoice.proposalId).toBe('prop-1')
    expect(invoice.lines).toHaveLength(2)
    expect(invoice.lines[0].description).toBe('plans')
    expect(invoice.lines[1].unit).toBe('hr')
    expect(invoice.total).toBe(4500 + 8 * 165)
  })

  it('throws when the proposal belongs to a different project', () => {
    const project = makeProject(h)
    const otherProject = h.projects.createProject(
      { number: '25099', name: 'Other' },
      { actor: { type: 'user' } },
    )
    const estimate = h.proposals.createEstimate(
      { projectId: otherProject.id, lines: [] },
      { actor: { type: 'user' } },
    )
    h.db.prepare(
      `INSERT INTO proposal (id, project_id, estimate_id, number, status, template_name,
                             metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', 'default', '{}', ?, ?)`,
    ).run('prop-other', otherProject.id, estimate.id, '25099-P1', Date.now(), Date.now())
    expect(() =>
      h.invoicing.createInvoiceFromProposal(
        { projectId: project.id, proposalId: 'prop-other' },
        { actor: { type: 'user' } },
      ),
    ).toThrow(/belongs to project/i)
  })
})

describe('InvoicingService.getProjectBudget', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('returns zeros when no estimates or invoices exist', () => {
    const project = makeProject(h)
    const budget = h.invoicing.getProjectBudget(project.id)
    expect(budget).toEqual({
      projectId: project.id,
      budgetTotal: 0,
      invoicedTotal: 0,
      paidTotal: 0,
    })
  })

  it('counts only accepted estimates toward budget_total', () => {
    const project = makeProject(h)
    const draft = h.proposals.createEstimate(
      {
        projectId: project.id,
        lines: [{ description: 'a', qty: 1, unitPrice: 5000 }],
      },
      { actor: { type: 'user' } },
    )
    expect(h.invoicing.getProjectBudget(project.id).budgetTotal).toBe(0)
    h.proposals.setEstimateStatus(draft.id, 'accepted', { actor: { type: 'user' } })
    expect(h.invoicing.getProjectBudget(project.id).budgetTotal).toBe(5000)
  })

  it('reflects non-void invoiced_total + paid_total in real time', () => {
    const project = makeProject(h)
    const a = h.invoicing.createInvoice(
      { projectId: project.id, lines: [{ description: 'a', qty: 1, unitPrice: 1000 }] },
      { actor: { type: 'user' } },
    )
    const b = h.invoicing.createInvoice(
      { projectId: project.id, lines: [{ description: 'b', qty: 1, unitPrice: 500 }] },
      { actor: { type: 'user' } },
    )
    h.invoicing.recordPayment(
      { invoiceId: a.id, amount: 300 },
      { actor: { type: 'user' } },
    )
    let budget = h.invoicing.getProjectBudget(project.id)
    expect(budget.invoicedTotal).toBe(1500)
    expect(budget.paidTotal).toBe(300)

    // Voiding b removes it from the rollup.
    h.invoicing.setInvoiceStatus(b.id, 'void', { actor: { type: 'user' } })
    budget = h.invoicing.getProjectBudget(project.id)
    expect(budget.invoicedTotal).toBe(1000)
  })
})

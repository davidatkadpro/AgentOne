import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog, type AuditLog } from '@/modules/audit-log.js'
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
  audit: AuditLog
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
  const invoicing = createInvoicingService({ db, eventBus: bus, audit })
  return { db, bus, audit, projects, proposals, invoicing }
}

function dispose(h: Harness): void {
  h.db.close()
}

describe('InvoicingService.createInvoice — tracer', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    dispose(h)
  })

  function makeProject(): { id: string; number: string } {
    const p = h.projects.createProject(
      { number: '25001', name: 'Riverside Reno' },
      { actor: { type: 'user' } },
    )
    return { id: p.id, number: p.number }
  }

  it("inserts a draft invoice numbered '<project-number>-01' with line totals + total", () => {
    const project = makeProject()
    const invoice = h.invoicing.createInvoice(
      {
        projectId: project.id,
        lines: [
          { kind: 'fixed', description: 'SD package', qty: 1, unitPrice: 3000 },
          {
            kind: 'time_and_materials',
            description: 'Site visits',
            qty: 6,
            unit: 'hr',
            unitPrice: 165,
          },
        ],
      },
      { actor: { type: 'user' } },
    )
    expect(invoice.number).toBe('25001-01')
    expect(invoice.status).toBe('draft')
    expect(invoice.lines).toHaveLength(2)
    expect(invoice.subtotal).toBe(3000 + 6 * 165)
    expect(invoice.total).toBe(invoice.subtotal + invoice.taxAmount)
    expect(invoice.amountPaid).toBe(0)
    expect(invoice.syncStatus).toBe('local')

    const refetched = h.invoicing.getInvoice(invoice.id)
    expect(refetched).toEqual(invoice)
  })

  it('increments -02, -03 for subsequent invoices on the same project', () => {
    const project = makeProject()
    const a = h.invoicing.createInvoice(
      { projectId: project.id, lines: [] },
      { actor: { type: 'user' } },
    )
    const b = h.invoicing.createInvoice(
      { projectId: project.id, lines: [] },
      { actor: { type: 'user' } },
    )
    const c = h.invoicing.createInvoice(
      { projectId: project.id, lines: [] },
      { actor: { type: 'user' } },
    )
    expect([a.number, b.number, c.number]).toEqual(['25001-01', '25001-02', '25001-03'])
  })

  it('emits invoice.created and writes an audit row', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('invoice.created', (e) => {
      captured.push(e)
    })
    const project = makeProject()
    const inv = h.invoicing.createInvoice(
      { projectId: project.id, lines: [] },
      { actor: { type: 'agent', sessionId: 'sess-1' } },
    )
    await new Promise((r) => setImmediate(r))
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      type: 'invoice.created',
      invoiceId: inv.id,
      number: '25001-01',
    })
    expect(h.audit.listByEntity('invoice', inv.id)[0].action).toBe('invoice.created')
  })

  it('throws on unknown project (FK)', () => {
    expect(() =>
      h.invoicing.createInvoice(
        { projectId: 'no-such', lines: [] },
        { actor: { type: 'user' } },
      ),
    ).toThrow()
  })

  it("includes explicit tax_amount in `total` when supplied", () => {
    const project = makeProject()
    const inv = h.invoicing.createInvoice(
      {
        projectId: project.id,
        taxAmount: 100,
        lines: [{ description: 'x', qty: 1, unitPrice: 1000 }],
      },
      { actor: { type: 'user' } },
    )
    expect(inv.subtotal).toBe(1000)
    expect(inv.taxAmount).toBe(100)
    expect(inv.total).toBe(1100)
  })
})

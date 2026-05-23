import { randomUUID } from 'node:crypto'
import type { Db } from '../../../src/storage/db.js'
import type { EventBus } from '../../../src/core/events.js'
import type { AuditActor, AuditLog } from '../../../src/modules/audit-log.js'
import type { ProjectsService } from '../../projects/src/service.js'
import type { ProposalsService } from '../../proposals/src/service.js'

export type InvoiceStatus = 'draft' | 'issued' | 'partial' | 'paid' | 'void'
export type SyncStatus = 'local' | 'pending' | 'synced' | 'drift' | 'failed'
export type LineKind = 'fixed' | 'time_and_materials' | 'unit'
export type PaymentMethod = 'check' | 'ach' | 'card' | 'wire' | 'cash' | 'other'

export interface InvoiceLine {
  id: string
  invoiceId: string
  kind: LineKind
  description: string
  qty: number
  unit: string | null
  unitPrice: number
  lineTotal: number
  position: number
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface Payment {
  id: string
  invoiceId: string
  amount: number
  receivedAt: number
  method: PaymentMethod
  reference: string | null
  notes: string | null
  metadata: Record<string, unknown>
  createdAt: number
}

export interface Invoice {
  id: string
  projectId: string
  proposalId: string | null
  number: string
  status: InvoiceStatus
  subtotal: number
  taxAmount: number
  total: number
  amountPaid: number
  dueDate: number | null
  notes: string | null
  qboId: string | null
  qboDocNumber: string | null
  syncStatus: SyncStatus
  lastSyncedAt: number | null
  lastError: Record<string, unknown> | null
  previousInvoiceId: string | null
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  issuedAt: number | null
  paidAt: number | null
  lines: InvoiceLine[]
}

export interface ProjectBudget {
  projectId: string
  budgetTotal: number
  invoicedTotal: number
  paidTotal: number
}

export interface CreateInvoiceLineInput {
  kind?: LineKind
  description: string
  qty?: number
  unit?: string | null
  unitPrice?: number
  metadata?: Record<string, unknown>
}

export interface CreateInvoiceInput {
  projectId: string
  proposalId?: string | null
  taxAmount?: number
  dueDate?: number | null
  notes?: string | null
  metadata?: Record<string, unknown>
  lines: CreateInvoiceLineInput[]
}

export interface CreateInvoiceFromProposalInput {
  projectId: string
  proposalId: string
  taxAmount?: number
  dueDate?: number | null
  notes?: string | null
  metadata?: Record<string, unknown>
}

export interface RecordPaymentInput {
  invoiceId: string
  amount: number
  receivedAt?: number
  method?: PaymentMethod
  reference?: string | null
  notes?: string | null
  metadata?: Record<string, unknown>
}

export interface ActorContext {
  actor: AuditActor
}

export interface InvoicingService {
  createInvoice(input: CreateInvoiceInput, ctx: ActorContext): Invoice
  createInvoiceFromProposal(
    input: CreateInvoiceFromProposalInput,
    ctx: ActorContext,
  ): Invoice
  getInvoice(id: string): Invoice | undefined
  listInvoicesForProject(projectId: string): Invoice[]
  setInvoiceStatus(
    id: string,
    status: InvoiceStatus,
    ctx: ActorContext,
  ): void
  recordPayment(input: RecordPaymentInput, ctx: ActorContext): Payment
  listPayments(invoiceId: string): Payment[]
  getProjectBudget(projectId: string): ProjectBudget
}

export interface InvoicingServiceDeps {
  db: Db
  eventBus: EventBus
  audit: AuditLog
  /** Optional — only required for createInvoiceFromProposal (resolves the
   *  proposal's estimate lines into invoice lines). */
  projects?: ProjectsService
  proposals?: ProposalsService
}

interface InvoiceRow {
  id: string
  project_id: string
  proposal_id: string | null
  number: string
  status: string
  subtotal: number
  tax_amount: number
  total: number
  amount_paid: number
  due_date: number | null
  notes: string | null
  qbo_id: string | null
  qbo_doc_number: string | null
  sync_status: string
  last_synced_at: number | null
  last_error_json: string | null
  previous_invoice_id: string | null
  metadata_json: string
  created_at: number
  updated_at: number
  issued_at: number | null
  paid_at: number | null
}

interface InvoiceLineRow {
  id: string
  invoice_id: string
  kind: string
  description: string
  qty: number
  unit: string | null
  unit_price: number
  line_total: number
  position: number
  metadata_json: string
  created_at: number
  updated_at: number
}

interface PaymentRow {
  id: string
  invoice_id: string
  amount: number
  received_at: number
  method: string
  reference: string | null
  notes: string | null
  metadata_json: string
  created_at: number
}

const VALID_STATUS: ReadonlySet<InvoiceStatus> = new Set([
  'draft',
  'issued',
  'partial',
  'paid',
  'void',
])
const VALID_SYNC: ReadonlySet<SyncStatus> = new Set([
  'local',
  'pending',
  'synced',
  'drift',
  'failed',
])
const VALID_KIND: ReadonlySet<LineKind> = new Set(['fixed', 'time_and_materials', 'unit'])
const VALID_METHOD: ReadonlySet<PaymentMethod> = new Set([
  'check',
  'ach',
  'card',
  'wire',
  'cash',
  'other',
])

function parseStatus(raw: string): InvoiceStatus {
  if (VALID_STATUS.has(raw as InvoiceStatus)) return raw as InvoiceStatus
  throw new Error(`Invalid invoice status: ${raw}`)
}
function parseSyncStatus(raw: string): SyncStatus {
  if (VALID_SYNC.has(raw as SyncStatus)) return raw as SyncStatus
  throw new Error(`Invalid sync_status: ${raw}`)
}
function parseKind(raw: string): LineKind {
  if (VALID_KIND.has(raw as LineKind)) return raw as LineKind
  throw new Error(`Invalid line kind: ${raw}`)
}
function parseMethod(raw: string): PaymentMethod {
  if (VALID_METHOD.has(raw as PaymentMethod)) return raw as PaymentMethod
  throw new Error(`Invalid payment method: ${raw}`)
}

function rowToLine(row: InvoiceLineRow): InvoiceLine {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    kind: parseKind(row.kind),
    description: row.description,
    qty: row.qty,
    unit: row.unit,
    unitPrice: row.unit_price,
    lineTotal: row.line_total,
    position: row.position,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    amount: row.amount,
    receivedAt: row.received_at,
    method: parseMethod(row.method),
    reference: row.reference,
    notes: row.notes,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  }
}

function rowToInvoice(row: InvoiceRow, lines: InvoiceLine[]): Invoice {
  return {
    id: row.id,
    projectId: row.project_id,
    proposalId: row.proposal_id,
    number: row.number,
    status: parseStatus(row.status),
    subtotal: row.subtotal,
    taxAmount: row.tax_amount,
    total: row.total,
    amountPaid: row.amount_paid,
    dueDate: row.due_date,
    notes: row.notes,
    qboId: row.qbo_id,
    qboDocNumber: row.qbo_doc_number,
    syncStatus: parseSyncStatus(row.sync_status),
    lastSyncedAt: row.last_synced_at,
    lastError:
      row.last_error_json !== null
        ? (JSON.parse(row.last_error_json) as Record<string, unknown>)
        : null,
    previousInvoiceId: row.previous_invoice_id,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    issuedAt: row.issued_at,
    paidAt: row.paid_at,
    lines,
  }
}

export function createInvoicingService(deps: InvoicingServiceDeps): InvoicingService {
  const getProjectStmt = deps.db.prepare(
    'SELECT id, number FROM project WHERE id = ?',
  )
  const listExistingNumbersStmt = deps.db.prepare(
    'SELECT number FROM invoice WHERE project_id = ?',
  )
  const insertInvoice = deps.db.prepare(
    `INSERT INTO invoice
       (id, project_id, proposal_id, number, subtotal, tax_amount, total,
        due_date, notes, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertLine = deps.db.prepare(
    `INSERT INTO invoice_line
       (id, invoice_id, kind, description, qty, unit, unit_price, line_total,
        position, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const getInvoiceStmt = deps.db.prepare('SELECT * FROM invoice WHERE id = ?')
  const listLinesStmt = deps.db.prepare(
    'SELECT * FROM invoice_line WHERE invoice_id = ? ORDER BY position ASC, rowid ASC',
  )
  const listInvoicesByProjectStmt = deps.db.prepare(
    'SELECT * FROM invoice WHERE project_id = ? ORDER BY created_at DESC, rowid DESC',
  )
  const updateInvoiceStatusStmt = deps.db.prepare(
    `UPDATE invoice
       SET status = ?, updated_at = ?,
           issued_at = CASE WHEN ? = 'issued' AND issued_at IS NULL THEN ? ELSE issued_at END,
           paid_at   = CASE WHEN ? = 'paid'   AND paid_at IS NULL   THEN ? ELSE paid_at   END
     WHERE id = ?`,
  )
  const insertPayment = deps.db.prepare(
    `INSERT INTO payment
       (id, invoice_id, amount, received_at, method, reference, notes,
        metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const updateAmountPaidStmt = deps.db.prepare(
    `UPDATE invoice
       SET amount_paid = amount_paid + ?, updated_at = ?,
           status = CASE
             WHEN amount_paid + ? >= total THEN 'paid'
             WHEN amount_paid + ? > 0      THEN 'partial'
             ELSE status
           END,
           paid_at = CASE
             WHEN amount_paid + ? >= total AND paid_at IS NULL THEN ?
             ELSE paid_at
           END
     WHERE id = ?`,
  )
  const listPaymentsStmt = deps.db.prepare(
    'SELECT * FROM payment WHERE invoice_id = ? ORDER BY received_at DESC, rowid DESC',
  )
  const projectBudgetStmt = deps.db.prepare(
    'SELECT * FROM project_budget WHERE project_id = ?',
  )

  function loadLines(invoiceId: string): InvoiceLine[] {
    const rows = listLinesStmt.all(invoiceId) as InvoiceLineRow[]
    return rows.map(rowToLine)
  }

  function nextInvoiceNumber(projectId: string, projectNumber: string): string {
    const rows = listExistingNumbersStmt.all(projectId) as { number: string }[]
    const prefix = `${projectNumber}-`
    let maxSeq = 0
    for (const r of rows) {
      if (r.number.startsWith(prefix)) {
        const n = Number.parseInt(r.number.slice(prefix.length), 10)
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n
      }
    }
    return `${prefix}${String(maxSeq + 1).padStart(2, '0')}`
  }

  function emitStatusEvent(
    status: InvoiceStatus,
    projectId: string,
    invoiceId: string,
    number: string,
    ts: number,
  ): void {
    if (status === 'issued') {
      void deps.eventBus.emit({
        type: 'invoice.issued',
        projectId,
        invoiceId,
        number,
        ts,
      })
    } else if (status === 'paid') {
      void deps.eventBus.emit({
        type: 'invoice.paid',
        projectId,
        invoiceId,
        number,
        ts,
      })
    } else if (status === 'void') {
      void deps.eventBus.emit({
        type: 'invoice.voided',
        projectId,
        invoiceId,
        number,
        ts,
      })
    }
  }

  return {
    createInvoice(input, ctx) {
      const project = getProjectStmt.get(input.projectId) as
        | { id: string; number: string }
        | undefined
      if (!project) {
        throw new Error(`Project not found: ${input.projectId}`)
      }
      const id = randomUUID()
      const now = Date.now()
      const taxAmount = input.taxAmount ?? 0
      const metadata = input.metadata ?? {}
      const number = nextInvoiceNumber(project.id, project.number)

      const lines: InvoiceLine[] = []
      let subtotal = 0
      input.lines.forEach((lineInput, idx) => {
        const lineId = randomUUID()
        const kind: LineKind = lineInput.kind ?? 'fixed'
        const qty = lineInput.qty ?? 1
        const unitPrice = lineInput.unitPrice ?? 0
        const lineTotal = qty * unitPrice
        subtotal += lineTotal
        const lineMeta = lineInput.metadata ?? {}
        lines.push({
          id: lineId,
          invoiceId: id,
          kind,
          description: lineInput.description,
          qty,
          unit: lineInput.unit ?? null,
          unitPrice,
          lineTotal,
          position: idx,
          metadata: lineMeta,
          createdAt: now,
          updatedAt: now,
        })
      })
      const total = subtotal + taxAmount

      insertInvoice.run(
        id,
        input.projectId,
        input.proposalId ?? null,
        number,
        subtotal,
        taxAmount,
        total,
        input.dueDate ?? null,
        input.notes ?? null,
        JSON.stringify(metadata),
        now,
        now,
      )
      for (const line of lines) {
        insertLine.run(
          line.id,
          line.invoiceId,
          line.kind,
          line.description,
          line.qty,
          line.unit,
          line.unitPrice,
          line.lineTotal,
          line.position,
          JSON.stringify(line.metadata),
          now,
          now,
        )
      }

      deps.audit.record({
        module: 'invoicing',
        action: 'invoice.created',
        entityType: 'invoice',
        entityId: id,
        actor: ctx.actor,
        payload: { projectId: input.projectId, number, total },
      })
      void deps.eventBus.emit({
        type: 'invoice.created',
        projectId: input.projectId,
        invoiceId: id,
        number,
        ts: now,
      })

      return {
        id,
        projectId: input.projectId,
        proposalId: input.proposalId ?? null,
        number,
        status: 'draft',
        subtotal,
        taxAmount,
        total,
        amountPaid: 0,
        dueDate: input.dueDate ?? null,
        notes: input.notes ?? null,
        qboId: null,
        qboDocNumber: null,
        syncStatus: 'local',
        lastSyncedAt: null,
        lastError: null,
        previousInvoiceId: null,
        metadata,
        createdAt: now,
        updatedAt: now,
        issuedAt: null,
        paidAt: null,
        lines,
      }
    },

    createInvoiceFromProposal(input, ctx) {
      if (!deps.proposals) {
        throw new Error('createInvoiceFromProposal requires `proposals` dep')
      }
      const proposal = deps.proposals.getProposal(input.proposalId)
      if (!proposal) {
        throw new Error(`Proposal not found: ${input.proposalId}`)
      }
      if (proposal.projectId !== input.projectId) {
        throw new Error(
          `Proposal ${input.proposalId} belongs to project ${proposal.projectId}, not ${input.projectId}`,
        )
      }
      const estimate = deps.proposals.getEstimate(proposal.estimateId)
      if (!estimate) {
        throw new Error(`Estimate not found for proposal ${input.proposalId}`)
      }
      const fromInput: CreateInvoiceInput = {
        projectId: input.projectId,
        proposalId: input.proposalId,
        lines: estimate.lines.map((l) => ({
          kind: l.kind,
          description: l.description,
          qty: l.qty,
          ...(l.unit !== null ? { unit: l.unit } : {}),
          unitPrice: l.unitPrice,
        })),
      }
      if (input.taxAmount !== undefined) fromInput.taxAmount = input.taxAmount
      if (input.dueDate !== undefined) fromInput.dueDate = input.dueDate
      if (input.notes !== undefined) fromInput.notes = input.notes
      if (input.metadata !== undefined) fromInput.metadata = input.metadata
      return this.createInvoice(fromInput, ctx)
    },

    getInvoice(id) {
      const row = getInvoiceStmt.get(id) as InvoiceRow | undefined
      if (!row) return undefined
      return rowToInvoice(row, loadLines(id))
    },

    listInvoicesForProject(projectId) {
      const rows = listInvoicesByProjectStmt.all(projectId) as InvoiceRow[]
      return rows.map((r) => rowToInvoice(r, loadLines(r.id)))
    },

    setInvoiceStatus(id, status, ctx) {
      const row = getInvoiceStmt.get(id) as InvoiceRow | undefined
      if (!row) throw new Error(`Invoice not found: ${id}`)
      const now = Date.now()
      updateInvoiceStatusStmt.run(status, now, status, now, status, now, id)
      deps.audit.record({
        module: 'invoicing',
        action:
          status === 'issued'
            ? 'invoice.issued'
            : status === 'void'
              ? 'invoice.voided'
              : status === 'paid'
                ? 'invoice.paid'
                : 'invoice.updated',
        entityType: 'invoice',
        entityId: id,
        actor: ctx.actor,
        payload: { status, projectId: row.project_id, number: row.number },
      })
      emitStatusEvent(status, row.project_id, id, row.number, now)
    },

    recordPayment(input, ctx) {
      const row = getInvoiceStmt.get(input.invoiceId) as InvoiceRow | undefined
      if (!row) throw new Error(`Invoice not found: ${input.invoiceId}`)
      if (row.status === 'void') {
        throw new Error('Cannot record payment on a voided invoice')
      }
      if (input.amount <= 0) {
        throw new Error('Payment amount must be positive')
      }
      const id = randomUUID()
      const now = Date.now()
      const receivedAt = input.receivedAt ?? now
      const method: PaymentMethod = input.method ?? 'other'
      const metadata = input.metadata ?? {}

      insertPayment.run(
        id,
        input.invoiceId,
        input.amount,
        receivedAt,
        method,
        input.reference ?? null,
        input.notes ?? null,
        JSON.stringify(metadata),
        now,
      )
      // amount_paid + status (partial / paid) update in one go.
      updateAmountPaidStmt.run(
        input.amount,
        now,
        input.amount,
        input.amount,
        input.amount,
        now,
        input.invoiceId,
      )

      deps.audit.record({
        module: 'invoicing',
        action: 'payment.recorded',
        entityType: 'payment',
        entityId: id,
        actor: ctx.actor,
        payload: {
          invoiceId: input.invoiceId,
          projectId: row.project_id,
          amount: input.amount,
        },
      })
      void deps.eventBus.emit({
        type: 'payment.recorded',
        projectId: row.project_id,
        invoiceId: input.invoiceId,
        paymentId: id,
        amount: input.amount,
        ts: now,
      })

      // If the payment pushed the invoice to fully paid, emit invoice.paid too
      // so downstream listeners (KPI rollup, notifications) only need one
      // subscription for "this invoice closed out."
      const refreshed = getInvoiceStmt.get(input.invoiceId) as InvoiceRow
      if (refreshed.status === 'paid' && row.status !== 'paid') {
        void deps.eventBus.emit({
          type: 'invoice.paid',
          projectId: row.project_id,
          invoiceId: input.invoiceId,
          number: row.number,
          ts: now,
        })
      }

      return {
        id,
        invoiceId: input.invoiceId,
        amount: input.amount,
        receivedAt,
        method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        metadata,
        createdAt: now,
      }
    },

    listPayments(invoiceId) {
      const rows = listPaymentsStmt.all(invoiceId) as PaymentRow[]
      return rows.map(rowToPayment)
    },

    getProjectBudget(projectId) {
      const row = projectBudgetStmt.get(projectId) as
        | { project_id: string; budget_total: number; invoiced_total: number; paid_total: number }
        | undefined
      if (!row) {
        return { projectId, budgetTotal: 0, invoicedTotal: 0, paidTotal: 0 }
      }
      return {
        projectId: row.project_id,
        budgetTotal: row.budget_total,
        invoicedTotal: row.invoiced_total,
        paidTotal: row.paid_total,
      }
    },
  }
}

import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  type ActorContext,
  type InvoicingService,
  type InvoiceStatus,
  type LineKind,
  type PaymentMethod,
} from './service.js'

const LineKindEnum: z.ZodType<LineKind> = z.enum(['fixed', 'time_and_materials', 'unit'])
const InvoiceStatusEnum: z.ZodType<InvoiceStatus> = z.enum([
  'draft',
  'issued',
  'partial',
  'paid',
  'void',
])
const PaymentMethodEnum: z.ZodType<PaymentMethod> = z.enum([
  'check',
  'ach',
  'card',
  'wire',
  'cash',
  'other',
])

const CreateInvoiceBody = z.object({
  proposalId: z.string().optional(),
  taxAmount: z.number().nonnegative().optional(),
  dueDate: z.number().int().optional(),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  lines: z.array(
    z.object({
      kind: LineKindEnum.optional(),
      description: z.string().min(1),
      qty: z.number().nonnegative().optional(),
      unit: z.string().optional(),
      unitPrice: z.number().nonnegative().optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
  ),
})

const CreateFromProposalBody = z.object({
  proposalId: z.string().min(1),
  taxAmount: z.number().nonnegative().optional(),
  dueDate: z.number().int().optional(),
  notes: z.string().optional(),
})

const RecordPaymentBody = z.object({
  amount: z.number().positive(),
  receivedAt: z.number().int().optional(),
  method: PaymentMethodEnum.optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
})

const PatchStatusBody = z.object({ status: InvoiceStatusEnum })

const ProjectIdParams = z.object({ projectId: z.string().min(1) })
const InvoiceIdParams = z.object({ id: z.string().min(1) })

const HTTP_ACTOR: ActorContext = { actor: { type: 'user' } }

export interface RegisterInvoicingRoutesDeps {
  service: InvoicingService
}

export async function registerInvoicingRoutes(
  app: FastifyInstance,
  deps: RegisterInvoicingRoutesDeps,
): Promise<void> {
  const { service } = deps

  app.post('/api/v1/projects/:projectId/invoices', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = CreateInvoiceBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    try {
      const input: Parameters<typeof service.createInvoice>[0] = {
        projectId: params.data.projectId,
        lines: body.data.lines,
      }
      if (body.data.proposalId !== undefined) input.proposalId = body.data.proposalId
      if (body.data.taxAmount !== undefined) input.taxAmount = body.data.taxAmount
      if (body.data.dueDate !== undefined) input.dueDate = body.data.dueDate
      if (body.data.notes !== undefined) input.notes = body.data.notes
      if (body.data.metadata !== undefined) input.metadata = body.data.metadata
      const invoice = service.createInvoice(input, HTTP_ACTOR)
      reply.code(201)
      return { invoice }
    } catch (err) {
      reply.code(400)
      return {
        error: 'CREATE_INVOICE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }
    }
  })

  app.post('/api/v1/projects/:projectId/invoices/from-proposal', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = CreateFromProposalBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    try {
      const input: Parameters<typeof service.createInvoiceFromProposal>[0] = {
        projectId: params.data.projectId,
        proposalId: body.data.proposalId,
      }
      if (body.data.taxAmount !== undefined) input.taxAmount = body.data.taxAmount
      if (body.data.dueDate !== undefined) input.dueDate = body.data.dueDate
      if (body.data.notes !== undefined) input.notes = body.data.notes
      const invoice = service.createInvoiceFromProposal(input, HTTP_ACTOR)
      reply.code(201)
      return { invoice }
    } catch (err) {
      reply.code(400)
      return {
        error: 'FROM_PROPOSAL_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }
    }
  })

  app.get('/api/v1/projects/:projectId/invoices', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    return { invoices: service.listInvoicesForProject(params.data.projectId) }
  })

  app.get('/api/v1/projects/:projectId/budget', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    return { budget: service.getProjectBudget(params.data.projectId) }
  })

  app.get('/api/v1/invoices/:id', async (req, reply) => {
    const params = InvoiceIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const invoice = service.getInvoice(params.data.id)
    if (!invoice) {
      reply.code(404)
      return { error: 'NOT_FOUND' }
    }
    return { invoice, payments: service.listPayments(invoice.id) }
  })

  app.patch('/api/v1/invoices/:id/status', async (req, reply) => {
    const params = InvoiceIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = PatchStatusBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    try {
      service.setInvoiceStatus(params.data.id, body.data.status, HTTP_ACTOR)
    } catch {
      reply.code(404)
      return { error: 'NOT_FOUND' }
    }
    return { invoice: service.getInvoice(params.data.id) }
  })

  app.post('/api/v1/invoices/:id/payments', async (req, reply) => {
    const params = InvoiceIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = RecordPaymentBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    try {
      const input: Parameters<typeof service.recordPayment>[0] = {
        invoiceId: params.data.id,
        amount: body.data.amount,
      }
      if (body.data.receivedAt !== undefined) input.receivedAt = body.data.receivedAt
      if (body.data.method !== undefined) input.method = body.data.method
      if (body.data.reference !== undefined) input.reference = body.data.reference
      if (body.data.notes !== undefined) input.notes = body.data.notes
      const payment = service.recordPayment(input, HTTP_ACTOR)
      reply.code(201)
      return { payment, invoice: service.getInvoice(params.data.id) }
    } catch (err) {
      reply.code(400)
      return {
        error: 'RECORD_PAYMENT_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }
    }
  })
}

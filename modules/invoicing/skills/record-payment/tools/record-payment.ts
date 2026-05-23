import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { InvoicingService } from '../../../src/service.js'

export const parameters = z.object({
  invoice_id: z.string().min(1),
  amount: z.number().positive(),
  method: z.enum(['check', 'ach', 'card', 'wire', 'cash', 'other']).optional(),
  reference: z.string().optional().describe('Check #, ACH reference, etc.'),
  received_at: z.number().int().optional().describe('Milliseconds epoch; defaults to now.'),
  notes: z.string().optional(),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const handle = ctx.services.modules.get('invoicing')
  if (!handle?.service) {
    return fail('RESOURCE_UNAVAILABLE', 'invoicing module is not active', false)
  }
  const service = handle.service as InvoicingService
  try {
    const input: Parameters<typeof service.recordPayment>[0] = {
      invoiceId: args.invoice_id,
      amount: args.amount,
    }
    if (args.method !== undefined) input.method = args.method
    if (args.reference !== undefined) input.reference = args.reference
    if (args.received_at !== undefined) input.receivedAt = args.received_at
    if (args.notes !== undefined) input.notes = args.notes
    const payment = service.recordPayment(input, {
      actor: { type: 'agent', sessionId: ctx.sessionId },
    })
    const invoice = service.getInvoice(args.invoice_id)
    return ok({
      payment_id: payment.id,
      invoice_status: invoice?.status,
      amount_paid: invoice?.amountPaid,
      balance: invoice ? invoice.total - invoice.amountPaid : null,
    })
  } catch (err) {
    return fail(
      'TOOL_VALIDATION',
      err instanceof Error ? err.message : String(err),
      true,
    )
  }
}

export default { parameters, handler }

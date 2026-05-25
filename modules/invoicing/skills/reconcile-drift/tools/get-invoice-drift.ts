import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { InvoicingService } from '../../../src/service.js'

export const parameters = z.object({
  invoice_id: z.string().min(1),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const service = ctx.services.modules.getActiveService<InvoicingService>('invoicing')
  if (!service) {
    return fail('RESOURCE_UNAVAILABLE', 'invoicing module is not active', false)
  }
  const invoice = service.getInvoice(args.invoice_id)
  if (!invoice) {
    return fail('TOOL_VALIDATION', `Invoice ${args.invoice_id} not found`, true)
  }
  if (invoice.syncStatus !== 'drift') {
    return ok({
      invoice_id: invoice.id,
      sync_status: invoice.syncStatus,
      drift: null,
      note: 'Invoice is not currently in drift — nothing to reconcile.',
    })
  }
  return ok({
    invoice_id: invoice.id,
    sync_status: 'drift',
    drift: {
      drift_fields: invoice.driftFields,
      local: {
        number: invoice.number,
        total: invoice.total,
        balance: invoice.total - invoice.amountPaid,
        line_count: invoice.lines.length,
        due_date: invoice.dueDate,
      },
      qbo: invoice.qboPullSnapshot ?? {},
    },
  })
}

export default { parameters, handler }

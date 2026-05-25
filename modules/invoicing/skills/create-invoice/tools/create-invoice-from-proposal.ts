import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { InvoicingService } from '../../../src/service.js'

export const parameters = z.object({
  project_id: z.string().min(1),
  proposal_id: z.string().min(1),
  tax_amount: z.number().nonnegative().optional(),
  due_date: z.number().int().optional().describe('Milliseconds epoch.'),
  notes: z.string().optional(),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const service = ctx.services.modules.getActiveService<InvoicingService>('invoicing')
  if (!service) {
    return fail('RESOURCE_UNAVAILABLE', 'invoicing module is not active', false)
  }
  try {
    const input: Parameters<typeof service.createInvoiceFromProposal>[0] = {
      projectId: args.project_id,
      proposalId: args.proposal_id,
    }
    if (args.tax_amount !== undefined) input.taxAmount = args.tax_amount
    if (args.due_date !== undefined) input.dueDate = args.due_date
    if (args.notes !== undefined) input.notes = args.notes
    const invoice = service.createInvoiceFromProposal(input, {
      actor: { type: 'agent', sessionId: ctx.sessionId },
    })
    return ok({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      total: invoice.total,
      line_count: invoice.lines.length,
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

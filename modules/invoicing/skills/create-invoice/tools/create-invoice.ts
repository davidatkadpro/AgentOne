import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { InvoicingService } from '../../../src/service.js'

const Line = z.object({
  kind: z.enum(['fixed', 'time_and_materials', 'unit']).optional(),
  description: z.string().min(1),
  qty: z.number().nonnegative().optional(),
  unit: z.string().optional(),
  unit_price: z.number().nonnegative().optional(),
})

export const parameters = z.object({
  project_id: z.string().min(1),
  tax_amount: z.number().nonnegative().optional(),
  due_date: z.number().int().optional(),
  notes: z.string().optional(),
  lines: z.array(Line).min(1),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const service = ctx.services.modules.getActiveService<InvoicingService>('invoicing')
  if (!service) {
    return fail('RESOURCE_UNAVAILABLE', 'invoicing module is not active', false)
  }
  try {
    const input: Parameters<typeof service.createInvoice>[0] = {
      projectId: args.project_id,
      lines: args.lines.map((l) => {
        const line: Parameters<typeof service.createInvoice>[0]['lines'][number] = {
          description: l.description,
        }
        if (l.kind !== undefined) line.kind = l.kind
        if (l.qty !== undefined) line.qty = l.qty
        if (l.unit !== undefined) line.unit = l.unit
        if (l.unit_price !== undefined) line.unitPrice = l.unit_price
        return line
      }),
    }
    if (args.tax_amount !== undefined) input.taxAmount = args.tax_amount
    if (args.due_date !== undefined) input.dueDate = args.due_date
    if (args.notes !== undefined) input.notes = args.notes
    const invoice = service.createInvoice(input, {
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

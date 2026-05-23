import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { ProposalsService } from '../../../src/service.js'

const Line = z.object({
  kind: z.enum(['fixed', 'time_and_materials', 'unit']).optional(),
  description: z.string().min(1),
  qty: z.number().nonnegative().optional(),
  unit: z.string().optional(),
  unit_price: z.number().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
})

export const parameters = z.object({
  project_id: z.string().min(1),
  source_scope_path: z
    .string()
    .optional()
    .describe('Relative path to the scope.md this estimate was built from.'),
  notes: z.string().optional(),
  lines: z.array(Line).min(1),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const handle = ctx.services.modules.get('proposals')
  if (!handle?.service) {
    return fail('RESOURCE_UNAVAILABLE', 'proposals module is not active', false)
  }
  const service = handle.service as ProposalsService
  try {
    const input: Parameters<typeof service.createEstimate>[0] = {
      projectId: args.project_id,
      lines: args.lines.map((l) => {
        const out: Parameters<typeof service.createEstimate>[0]['lines'][number] = {
          description: l.description,
        }
        if (l.kind !== undefined) out.kind = l.kind
        if (l.qty !== undefined) out.qty = l.qty
        if (l.unit !== undefined) out.unit = l.unit
        if (l.unit_price !== undefined) out.unitPrice = l.unit_price
        if (l.metadata !== undefined) out.metadata = l.metadata
        return out
      }),
    }
    if (args.source_scope_path !== undefined) input.sourceScopePath = args.source_scope_path
    if (args.notes !== undefined) input.notes = args.notes
    const estimate = service.createEstimate(input, {
      actor: { type: 'agent', sessionId: ctx.sessionId },
    })
    const total = estimate.lines.reduce((sum, l) => sum + l.lineTotal, 0)
    return ok({
      id: estimate.id,
      project_id: estimate.projectId,
      status: estimate.status,
      line_count: estimate.lines.length,
      total,
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

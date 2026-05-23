import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { ProposalsService } from '../../../src/service.js'

export const parameters = z.object({
  project_id: z.string().min(1),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const handle = ctx.services.modules.get('proposals')
  if (!handle?.service) {
    return fail('RESOURCE_UNAVAILABLE', 'proposals module is not active', false)
  }
  const estimates = (handle.service as ProposalsService).listEstimatesForProject(
    args.project_id,
  )
  return ok({
    estimates: estimates.map((e) => ({
      id: e.id,
      status: e.status,
      version: e.version,
      line_count: e.lines.length,
      total: e.lines.reduce((sum, l) => sum + l.lineTotal, 0),
      source_scope_path: e.sourceScopePath,
      notes: e.notes,
      created_at: e.createdAt,
    })),
  })
}

export default { parameters, handler }

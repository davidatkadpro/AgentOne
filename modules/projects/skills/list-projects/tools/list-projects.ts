import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { EntityStatus, ProjectsService } from '../../../src/service.js'

const StatusEnum = z.enum(['pending', 'active', 'blocked', 'completed', 'cancelled'])

export const parameters = z.object({
  status: z
    .array(StatusEnum)
    .optional()
    .describe('Statuses to include. Omit for all.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Max rows; default 50.'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const service = ctx.services.modules.getActiveService<ProjectsService>('projects')
  if (!service) {
    return fail(
      'RESOURCE_UNAVAILABLE',
      'projects module is not active in this runtime',
      false,
    )
  }
  const opts: { status?: EntityStatus[]; limit?: number } = { limit: args.limit ?? 50 }
  if (args.status !== undefined) opts.status = args.status
  const projects = service.listProjects(opts)
  return ok({
    count: projects.length,
    projects: projects.map((p) => ({
      id: p.id,
      number: p.number,
      name: p.name,
      client: p.client,
      status: p.status,
      updated_at: p.updatedAt,
    })),
  })
}

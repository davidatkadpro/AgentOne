import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { ProjectsService } from '../../../../projects/src/service.js'

export const parameters = z.object({
  limit: z.number().int().positive().max(50).optional(),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const handle = ctx.services.modules.get('projects')
  if (!handle?.service) {
    return fail('RESOURCE_UNAVAILABLE', 'projects module is not active', false)
  }
  const projects = (handle.service as ProjectsService).listProjects({
    status: ['pending', 'active', 'blocked'],
    limit: args.limit ?? 20,
  })
  return ok({
    projects: projects.map((p) => ({
      id: p.id,
      number: p.number,
      name: p.name,
      client: p.client,
      status: p.status,
    })),
  })
}

export default { parameters, handler }

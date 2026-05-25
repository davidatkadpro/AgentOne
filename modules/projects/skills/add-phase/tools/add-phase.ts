import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { ProjectsService } from '../../../src/service.js'

export const parameters = z.object({
  project_id: z.string().min(1).describe('UUID of the project to add to.'),
  name: z.string().min(1).describe('Phase label (e.g. "SD").'),
  metadata: z.record(z.unknown()).optional(),
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
  try {
    const input: Parameters<typeof service.addPhase>[0] = {
      projectId: args.project_id,
      name: args.name,
    }
    if (args.metadata !== undefined) input.metadata = args.metadata
    const phase = service.addPhase(input, {
      actor: { type: 'agent', sessionId: ctx.sessionId },
    })
    return ok({
      id: phase.id,
      project_id: phase.projectId,
      name: phase.name,
      position: phase.position,
      status: phase.status,
    })
  } catch (err) {
    return fail(
      'TOOL_VALIDATION',
      err instanceof Error ? err.message : String(err),
      true,
    )
  }
}

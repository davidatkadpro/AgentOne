import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import {
  DuplicateProjectNumberError,
  type ProjectsService,
} from '../../../../projects/src/service.js'

export const parameters = z.object({
  number: z.string().min(1).describe('Project number (default format YY###).'),
  name: z.string().min(1).describe('Short project name.'),
  client: z.string().optional(),
  description: z.string().optional(),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const handle = ctx.services.modules.get('projects')
  if (!handle?.service) {
    return fail('RESOURCE_UNAVAILABLE', 'projects module is not active', false)
  }
  const service = handle.service as ProjectsService
  try {
    const input: Parameters<typeof service.createProject>[0] = {
      number: args.number,
      name: args.name,
    }
    if (args.client !== undefined) input.client = args.client
    if (args.description !== undefined) input.description = args.description
    const project = service.createProject(input, {
      actor: { type: 'agent', sessionId: ctx.sessionId },
    })
    return ok({
      id: project.id,
      number: project.number,
      name: project.name,
      status: project.status,
      folder_path: project.folderPath,
    })
  } catch (err) {
    if (err instanceof DuplicateProjectNumberError) {
      return fail(
        'TOOL_VALIDATION',
        `Project number "${err.number}" is already in use; ask suggest_next_project_number again.`,
        true,
      )
    }
    return fail(
      'TOOL_VALIDATION',
      err instanceof Error ? err.message : String(err),
      true,
    )
  }
}

export default { parameters, handler }

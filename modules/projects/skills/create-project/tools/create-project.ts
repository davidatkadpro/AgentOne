import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import {
  DuplicateProjectNumberError,
  type ProjectsService,
} from '../../../src/service.js'

export const parameters = z.object({
  number: z
    .string()
    .min(1)
    .describe('Operator-facing short identifier (e.g. "24001"). Must be unique.'),
  name: z.string().min(1).describe('Short descriptive name; used in the folder slug.'),
  client: z.string().optional().describe('Primary stakeholder / owner.'),
  description: z.string().optional().describe('What the project is about.'),
  folder_path: z
    .string()
    .optional()
    .describe('Override default `projects/<number> - <name>/` layout (rare).'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe('Ad-hoc JSON metadata (three-ring extension).'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const handle = ctx.services.modules.get('projects')
  if (!handle?.service) {
    return fail(
      'RESOURCE_UNAVAILABLE',
      'projects module is not active in this runtime',
      false,
    )
  }
  const service = handle.service as ProjectsService
  try {
    const input: Parameters<typeof service.createProject>[0] = {
      number: args.number,
      name: args.name,
    }
    if (args.client !== undefined) input.client = args.client
    if (args.description !== undefined) input.description = args.description
    if (args.folder_path !== undefined) input.folderPath = args.folder_path
    if (args.metadata !== undefined) input.metadata = args.metadata
    const project = service.createProject(input, {
      actor: { type: 'agent', sessionId: ctx.sessionId },
    })
    return ok({
      id: project.id,
      number: project.number,
      name: project.name,
      folder_path: project.folderPath,
      status: project.status,
    })
  } catch (err) {
    if (err instanceof DuplicateProjectNumberError) {
      return fail(
        'TOOL_VALIDATION',
        `Project number "${err.number}" is already in use. Ask the user for a different number.`,
        true,
      )
    }
    throw err
  }
}

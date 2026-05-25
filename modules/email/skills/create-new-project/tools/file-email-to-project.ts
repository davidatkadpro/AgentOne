import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { EmailService } from '../../../src/service.js'

export const parameters = z.object({
  email_id: z.string().min(1).describe('Id of the email to file.'),
  project_id: z.string().min(1).describe('Id of the project (newly created).'),
  body: z
    .string()
    .min(1)
    .describe('Markdown paragraph summarising why this project exists.'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const service = ctx.services.modules.getActiveService<EmailService>('email')
  if (!service) {
    return fail('RESOURCE_UNAVAILABLE', 'email module is not active', false)
  }
  try {
    const result = await service.fileToProject(
      {
        emailId: args.email_id,
        projectId: args.project_id,
        body: args.body,
      },
      { actor: { type: 'agent', sessionId: ctx.sessionId } },
    )
    return ok({
      folder_path: result.folderPath,
      message: `Filed trigger email into ${result.folderPath}`,
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

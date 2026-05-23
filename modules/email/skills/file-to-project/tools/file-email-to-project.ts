import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { EmailService } from '../../../src/service.js'

export const parameters = z.object({
  email_id: z.string().min(1).describe('Id of the email to file.'),
  project_id: z.string().min(1).describe('Id of the chosen project.'),
  body: z
    .string()
    .min(1)
    .describe('A one-paragraph markdown summary of the email. Written to email.md.'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const handle = ctx.services.modules.get('email')
  if (!handle?.service) {
    return fail('RESOURCE_UNAVAILABLE', 'email module is not active', false)
  }
  const service = handle.service as EmailService
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
      message: `Filed email ${args.email_id} into ${result.folderPath}`,
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

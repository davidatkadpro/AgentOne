import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { EmailService } from '../../../src/service.js'

export const parameters = z.object({
  email_id: z
    .string()
    .min(1)
    .describe('Id of the filed email. Its `filed_folder_path` becomes scope.md\'s home.'),
  frontmatter_yaml: z
    .string()
    .min(1)
    .describe(
      'YAML body (no `---` fences). The tool wraps it with fences when writing. Must include client, project_type, phases, assumptions, exclusions.',
    ),
  body: z
    .string()
    .min(1)
    .describe('Markdown prose with 3-10 ### sections describing the deliverables.'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const emailService = ctx.services.modules.getActiveService<EmailService>('email')
  if (!emailService) {
    return fail('RESOURCE_UNAVAILABLE', 'email module is not active', false)
  }
  const email = emailService.getEmail(args.email_id)
  if (!email) {
    return fail('TOOL_VALIDATION', `Email not found: ${args.email_id}`, false)
  }
  if (!email.filedFolderPath) {
    return fail(
      'TOOL_VALIDATION',
      `Email ${args.email_id} has not been filed yet — call file_email_to_project first.`,
      true,
    )
  }
  // Render: ---\n<yaml>\n---\n\n<body>\n
  const yaml = args.frontmatter_yaml.trim()
  const body = args.body.trim()
  const contents = `---\n${yaml}\n---\n\n${body}\n`
  try {
    await ctx.services.storage.write(`${email.filedFolderPath}/scope.md`, contents)
    return ok({
      path: `${email.filedFolderPath}/scope.md`,
      message: `Wrote scope.md (${contents.length} bytes)`,
    })
  } catch (err) {
    return fail(
      'TOOL_RUNTIME',
      err instanceof Error ? err.message : String(err),
      true,
    )
  }
}

export default { parameters, handler }

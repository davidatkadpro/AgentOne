import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { ProposalsService } from '../../../src/service.js'

export const parameters = z.object({
  project_id: z.string().min(1),
  estimate_id: z.string().min(1),
  template_name: z.string().optional().describe('Defaults to "default".'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const service = ctx.services.modules.getActiveService<ProposalsService>('proposals')
  if (!service) {
    return fail('RESOURCE_UNAVAILABLE', 'proposals module is not active', false)
  }
  try {
    const input: Parameters<typeof service.createProposal>[0] = {
      projectId: args.project_id,
      estimateId: args.estimate_id,
    }
    if (args.template_name !== undefined) input.templateName = args.template_name
    const proposal = await service.createProposal(input, {
      actor: { type: 'agent', sessionId: ctx.sessionId },
    })
    return ok({
      id: proposal.id,
      number: proposal.number,
      status: proposal.status,
      rendered_markdown_path: proposal.renderedMarkdownPath,
      message: `Wrote ${proposal.renderedMarkdownPath}`,
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

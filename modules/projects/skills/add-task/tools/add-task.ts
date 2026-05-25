import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { ProjectsService } from '../../../src/service.js'

export const parameters = z.object({
  project_id: z.string().min(1).describe('UUID of the project.'),
  phase_id: z.string().min(1).describe('UUID of the phase; must belong to project_id.'),
  title: z.string().min(1).describe('Short task title.'),
  description: z.string().optional().describe('Markdown body.'),
  parent_task_id: z.string().optional().describe('Make this a subtask of another task.'),
  assignee_profile: z
    .string()
    .optional()
    .describe('Agent profile id this task is assigned to (e.g. "drafter").'),
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
    const input: Parameters<typeof service.addTask>[0] = {
      projectId: args.project_id,
      phaseId: args.phase_id,
      title: args.title,
    }
    if (args.description !== undefined) input.description = args.description
    if (args.parent_task_id !== undefined) input.parentTaskId = args.parent_task_id
    if (args.assignee_profile !== undefined) input.assigneeProfile = args.assignee_profile
    if (args.metadata !== undefined) input.metadata = args.metadata
    const task = service.addTask(input, {
      actor: { type: 'agent', sessionId: ctx.sessionId },
    })
    return ok({
      id: task.id,
      project_id: task.projectId,
      phase_id: task.phaseId,
      parent_task_id: task.parentTaskId,
      title: task.title,
      status: task.status,
      assignee_profile: task.assigneeProfile,
      position: task.position,
    })
  } catch (err) {
    return fail(
      'TOOL_VALIDATION',
      err instanceof Error ? err.message : String(err),
      true,
    )
  }
}

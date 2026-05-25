import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { ProjectsService } from '../../../../projects/src/service.js'

export const parameters = z.object({
  /** Format hint. Defaults to YY### (e.g. 25001 in 2025). Future operator
   *  config will override this; today it's a constant. */
  format: z.enum(['YY###']).optional(),
})

export const handler: ToolHandler<typeof parameters> = async (_args, ctx) => {
  const service = ctx.services.modules.getActiveService<ProjectsService>('projects')
  if (!service) {
    return fail('RESOURCE_UNAVAILABLE', 'projects module is not active', false)
  }
  const projects = service.listProjects({ limit: 500 })
  const yy = String(new Date().getUTCFullYear() % 100).padStart(2, '0')
  const prefix = yy
  // Find the highest XXX suffix among numbers that match `<yy>###`.
  let maxSeq = 0
  for (const p of projects) {
    if (p.number.length === 5 && p.number.startsWith(prefix)) {
      const seq = Number.parseInt(p.number.slice(2), 10)
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
    }
  }
  const next = String(maxSeq + 1).padStart(3, '0')
  return ok({ suggested_number: `${prefix}${next}`, year: `20${yy}` })
}

export default { parameters, handler }

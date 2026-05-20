import { z } from 'zod'
import { defineCommand } from './types.js'

const args = z.object({
  skill: z.string().min(1).describe('Qualified skill name, e.g. "system/documents".'),
})

export const loadCommand = defineCommand({
  name: 'load',
  description: 'Load a skill into the current session.',
  usage: '/load <category>/<skill>',
  args,
  requiresSession: true,
  handler: async (parsed, ctx) => {
    const sessionId = ctx.sessionId as string
    if (!ctx.skillIndex.skills.has(parsed.skill)) {
      return {
        kind: 'error',
        message: `Skill not found: ${parsed.skill}`,
        recoverable: true,
      }
    }
    const result = await ctx.orchestrator.loadSkillIntoSession(sessionId, parsed.skill)
    if (result.alreadyLoaded) {
      return {
        kind: 'skill_loaded',
        skill: parsed.skill,
        toolsRegistered: [],
        alreadyLoaded: true,
      }
    }
    if (!result.loaded) {
      return {
        kind: 'error',
        message: `Could not load ${parsed.skill}: ${result.reason}`,
        recoverable: result.reason.startsWith('permission denied'),
      }
    }
    return {
      kind: 'skill_loaded',
      skill: parsed.skill,
      toolsRegistered: result.toolsRegistered,
      alreadyLoaded: false,
    }
  },
})

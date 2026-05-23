import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { SkillFrontmatterSchema } from '../../../src/skills/frontmatter.js'
import { parseFrontmatter } from '../../../src/memory/wiki/frontmatter.js'
import type { Orchestrator } from '../../../src/orchestrator/turn.js'
import type { EventBus } from '../../../src/core/events.js'
import type { ProjectsService } from '../../projects/src/service.js'

/**
 * Dispatch a proposals Skill against a project context. Mirrors
 * `modules/email/src/actions.ts` but with the project row as the contextId
 * rather than an email row. The same template-rendering rules apply.
 */
const DispatchBody = z.object({
  action: z.string().regex(/^[a-z0-9-]+$/),
  contextId: z.string().min(1),
  args: z.record(z.unknown()).optional(),
})

export interface RegisterProposalsActionsDeps {
  orchestrator: Orchestrator
  projects: ProjectsService
  /** Absolute path to `modules/proposals/skills/`. */
  skillsDir: string
  eventBus?: EventBus
}

interface ActionLookupResult {
  fm: ReturnType<typeof SkillFrontmatterSchema['parse']>
  promptTemplate: string
}

async function loadActionFrontmatter(
  skillsDir: string,
  action: string,
): Promise<ActionLookupResult | null> {
  const path = join(skillsDir, action, 'SKILL.md')
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return null
  }
  const parsed = parseFrontmatter(raw)
  const validated = SkillFrontmatterSchema.safeParse(parsed.frontmatter)
  if (!validated.success) return null
  return {
    fm: validated.data,
    promptTemplate: validated.data.prompt_template ?? parsed.body.trim(),
  }
}

function renderTemplate(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const parts = path.split('.')
    let cur: unknown = scope
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p]
      } else {
        return ''
      }
    }
    return cur == null ? '' : String(cur)
  })
}

/** POST `/api/proposals/actions` and `/api/v1/proposals/actions`. Discovery
 *  (GET) is handled by `registerModuleActionsDiscovery` per ADR-0007. */
export async function registerProposalsActions(
  app: FastifyInstance,
  deps: RegisterProposalsActionsDeps,
): Promise<void> {
  for (const url of ['/api/v1/proposals/actions', '/api/proposals/actions']) {
    app.post(url, async (req, reply) => {
      const body = DispatchBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      const project = deps.projects.getProject(body.data.contextId)
      if (!project) {
        reply.code(404)
        return { error: 'PROJECT_NOT_FOUND', contextId: body.data.contextId }
      }
      const skill = await loadActionFrontmatter(deps.skillsDir, body.data.action)
      if (!skill) {
        reply.code(404)
        return { error: 'UNKNOWN_ACTION', action: body.data.action }
      }
      const scope = {
        project: {
          id: project.id,
          number: project.number,
          name: project.name,
          client: project.client,
          folderPath: project.folderPath,
        },
        contextId: body.data.contextId,
        args: body.data.args ?? {},
      }
      const seedMessage = renderTemplate(skill.promptTemplate, scope).trim()
      if (seedMessage.length === 0) {
        reply.code(422)
        return {
          error: 'EMPTY_PROMPT_TEMPLATE',
          message: `Skill "${body.data.action}" rendered to an empty prompt.`,
        }
      }
      const spawnInput: Parameters<typeof deps.orchestrator.spawnSession>[0] = {
        spawnedBy: `modules/proposals/${body.data.action}`,
        initialMessage: seedMessage,
        title: skill.fm.label ?? body.data.action,
        allowedSkills: [`proposals/${body.data.action}`],
      }
      if (skill.fm.default_profile) {
        spawnInput.agentProfile = skill.fm.default_profile
      }
      const result = await deps.orchestrator.spawnSession(spawnInput)
      // Drain the stream in the background. We don't block the response on it.
      void (async () => {
        try {
          for await (const _ of result.handle.stream) {
            // discard
          }
        } catch {
          // best-effort
        }
      })()
      return { sessionId: result.session.id, action: body.data.action }
    })
  }
}

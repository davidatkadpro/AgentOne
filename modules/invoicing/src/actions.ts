import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { SkillFrontmatterSchema } from '../../../src/skills/frontmatter.js'
import { parseFrontmatter } from '../../../src/memory/wiki/frontmatter.js'
import type { Orchestrator } from '../../../src/orchestrator/turn.js'
import type { EventBus } from '../../../src/core/events.js'
import type { InvoicingService } from './service.js'

/**
 * Dispatch an invoicing Skill against an invoice context. Mirrors
 * `modules/proposals/src/actions.ts` — the invoice id is the contextId,
 * and the project id resolves through the invoice for skill template scope.
 */
const DispatchBody = z.object({
  action: z.string().regex(/^[a-z0-9-]+$/),
  contextId: z.string().min(1),
  args: z.record(z.unknown()).optional(),
})

export interface RegisterInvoicingActionsDeps {
  orchestrator: Orchestrator
  invoicing: InvoicingService
  /** Absolute path to `modules/invoicing/skills/`. */
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

export async function registerInvoicingActions(
  app: FastifyInstance,
  deps: RegisterInvoicingActionsDeps,
): Promise<void> {
  for (const url of ['/api/v1/invoicing/actions', '/api/invoicing/actions']) {
    app.post(url, async (req, reply) => {
      const body = DispatchBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      const invoice = deps.invoicing.getInvoice(body.data.contextId)
      if (!invoice) {
        reply.code(404)
        return { error: 'INVOICE_NOT_FOUND', contextId: body.data.contextId }
      }
      const skill = await loadActionFrontmatter(deps.skillsDir, body.data.action)
      if (!skill) {
        reply.code(404)
        return { error: 'UNKNOWN_ACTION', action: body.data.action }
      }
      const scope = {
        invoice: {
          id: invoice.id,
          number: invoice.number,
          status: invoice.status,
          projectId: invoice.projectId,
          total: invoice.total,
          balance: invoice.total - invoice.amountPaid,
          syncStatus: invoice.syncStatus,
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
        spawnedBy: `modules/invoicing/${body.data.action}`,
        initialMessage: seedMessage,
        title: skill.fm.label ?? body.data.action,
        allowedSkills: [`invoicing/${body.data.action}`],
      }
      if (skill.fm.default_profile) {
        spawnInput.agentProfile = skill.fm.default_profile
      }
      const result = await deps.orchestrator.spawnSession(spawnInput)
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

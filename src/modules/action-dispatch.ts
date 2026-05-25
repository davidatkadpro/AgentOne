import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { SkillFrontmatterSchema } from '../skills/frontmatter.js'
import { parseFrontmatter } from '../memory/wiki/frontmatter.js'
import type { Orchestrator } from '../orchestrator/turn.js'
import type { AgentEvent, EventBus } from '../core/events.js'

/**
 * Module-action dispatch (ADR-0007). One generic implementation; each module
 * supplies only the bits that legitimately differ — its entity lookup, the
 * template-scope shape, and (optionally) a custom request body schema for
 * back-compat aliases like email's legacy `emailId`.
 *
 * Discovery (`GET /api/<module>/actions`) lives in `action-discovery.ts`.
 * Dispatch (POST) lives here because it threads through the orchestrator and
 * needs per-module entity resolution.
 */

export interface ActionFrontmatter {
  fm: ReturnType<typeof SkillFrontmatterSchema['parse']>
  promptTemplate: string
}

/**
 * Load and validate a single SKILL.md inside `skillsDir/<action>/`. Returns
 * `null` for missing or invalid frontmatter (the dispatcher then 404s with
 * `UNKNOWN_ACTION`). The body of the SKILL.md serves as the prompt template
 * when no explicit `prompt_template` field is present in frontmatter.
 */
export async function loadActionFrontmatter(
  skillsDir: string,
  action: string,
): Promise<ActionFrontmatter | null> {
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

/**
 * Minimal `{{path.to.value}}` placeholder rendering. Not a full Mustache —
 * no sections, no partials, no escaping logic. Skills needing richer
 * rendering should compute their seed inside the Skill itself.
 */
export function renderTemplate(template: string, scope: Record<string, unknown>): string {
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

/**
 * Canonical dispatch body — `{ action, contextId, args? }`. Modules whose
 * legacy clients still send a different field (email's `emailId`) should
 * pass a custom schema that `.transform`s into this shape.
 */
export const CanonicalDispatchBody = z.object({
  action: z.string().regex(/^[a-z0-9-]+$/),
  contextId: z.string().min(1),
  args: z.record(z.unknown()).optional(),
})

export interface DispatchBody {
  action: string
  contextId: string
  args?: Record<string, unknown>
}

export interface ActionStartedContext<TEntity> {
  entity: TEntity
  contextId: string
  action: string
  sessionId: string
}

export interface ActionCompletedContext<TEntity> extends ActionStartedContext<TEntity> {
  ok: boolean
}

export interface ActionDispatchEvents<TEntity> {
  bus: EventBus
  onStarted(ctx: ActionStartedContext<TEntity>): AgentEvent
  onCompleted(ctx: ActionCompletedContext<TEntity>): AgentEvent
}

export interface ActionDispatchOptions<TEntity, TBody extends DispatchBody = DispatchBody> {
  /** Module name as it appears in `spawnedBy` / `allowedSkills` (e.g. 'email'). */
  module: string
  /** All URLs to mount POST on. Typically `['/api/v1/<m>/actions', '/api/<m>/actions']`. */
  urls: string[]
  /** Absolute path to `modules/<module>/skills/`. */
  skillsDir: string
  orchestrator: Orchestrator
  /** Body schema. Should `.transform` non-canonical fields into `DispatchBody`
   *  if any legacy aliases are accepted. Defaults to `CanonicalDispatchBody`.
   *  The third type parameter is `unknown` so callers can supply a schema
   *  whose input shape differs from the canonical output. */
  body?: z.ZodType<TBody, z.ZodTypeDef, unknown>
  /** Look up the entity by canonical contextId. `null` → 404 with `notFoundError`. */
  lookup(contextId: string): TEntity | null | Promise<TEntity | null>
  /** Error code returned when `lookup` resolves to null (e.g. `'EMAIL_NOT_FOUND'`). */
  notFoundError: string
  /** Build the template scope from the resolved entity + contextId + args.
   *  The returned record is passed straight to `renderTemplate`. */
  scopeBuilder(
    entity: TEntity,
    contextId: string,
    args: Record<string, unknown>,
  ): Record<string, unknown>
  /** Optional per-module event emission around the spawn. */
  events?: ActionDispatchEvents<TEntity>
}

/**
 * Mount `POST /api/.../actions` handlers that parse the body, look up the
 * context, render the SKILL.md prompt template, and spawn a session. Each
 * URL in `urls` gets the same handler — modules typically mount both
 * `/api/v1/<m>/actions` (legacy) and `/api/<m>/actions` (canonical).
 */
export async function registerModuleActionDispatch<TEntity, TBody extends DispatchBody = DispatchBody>(
  app: FastifyInstance,
  opts: ActionDispatchOptions<TEntity, TBody>,
): Promise<void> {
  const bodySchema = (opts.body ?? CanonicalDispatchBody) as z.ZodType<TBody, z.ZodTypeDef, unknown>
  for (const url of opts.urls) {
    app.post(url, async (req, reply) => {
      const body = bodySchema.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      const parsed = body.data
      const entity = await opts.lookup(parsed.contextId)
      if (!entity) {
        reply.code(404)
        return { error: opts.notFoundError, contextId: parsed.contextId }
      }
      const skill = await loadActionFrontmatter(opts.skillsDir, parsed.action)
      if (!skill) {
        reply.code(404)
        return { error: 'UNKNOWN_ACTION', action: parsed.action }
      }
      const scope = opts.scopeBuilder(entity, parsed.contextId, parsed.args ?? {})
      const seedMessage = renderTemplate(skill.promptTemplate, scope).trim()
      if (seedMessage.length === 0) {
        reply.code(422)
        return {
          error: 'EMPTY_PROMPT_TEMPLATE',
          message: `Skill "${parsed.action}" rendered to an empty prompt.`,
        }
      }
      const spawnInput: Parameters<Orchestrator['spawnSession']>[0] = {
        spawnedBy: `modules/${opts.module}/${parsed.action}`,
        initialMessage: seedMessage,
        title: skill.fm.label ?? parsed.action,
        allowedSkills: [`${opts.module}/${parsed.action}`],
      }
      if (skill.fm.default_profile) {
        spawnInput.agentProfile = skill.fm.default_profile
      }
      const result = await opts.orchestrator.spawnSession(spawnInput)
      const sessionId = result.session.id
      if (opts.events) {
        void opts.events.bus.emit(
          opts.events.onStarted({ entity, contextId: parsed.contextId, action: parsed.action, sessionId }),
        )
      }
      void (async () => {
        let ok = true
        try {
          for await (const _ of result.handle.stream) {
            // discard
          }
        } catch {
          ok = false
        }
        if (opts.events) {
          await opts.events.bus.emit(
            opts.events.onCompleted({
              entity,
              contextId: parsed.contextId,
              action: parsed.action,
              sessionId,
              ok,
            }),
          )
        }
      })()
      return { sessionId, action: parsed.action }
    })
  }
}

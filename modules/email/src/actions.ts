import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { SkillFrontmatterSchema } from '../../../src/skills/frontmatter.js'
import { parseFrontmatter } from '../../../src/memory/wiki/frontmatter.js'
import type { Orchestrator } from '../../../src/orchestrator/turn.js'
import type { Email, EmailService } from './service.js'

export interface EmailActionDescriptor {
  name: string
  label: string
  description: string
  icon: string | null
  defaultProfile: string | null
  requiresConfirmation: boolean
  surface: 'action' | 'ask_agent' | 'both'
  tabs: string[]
}

export interface EmailActionDiscovery {
  actions: EmailActionDescriptor[]
  errors: Array<{ skill: string; error: string }>
}

const DispatchBody = z.object({
  action: z.string().regex(/^[a-z0-9-]+$/),
  emailId: z.string().min(1),
  args: z.record(z.unknown()).optional(),
})

export interface RegisterEmailActionsDeps {
  service: EmailService
  orchestrator: Orchestrator
  /** Absolute path to `modules/email/skills/`. Used both for action
   *  discovery (scan SKILL.md files) and for the dispatcher to re-read the
   *  prompt_template on each call. */
  skillsDir: string
}

interface CachedDiscovery {
  mtimeMs: number
  result: EmailActionDiscovery
}

let discoveryCache: CachedDiscovery | null = null

/**
 * Walk `modules/email/skills/<name>/SKILL.md` files, parse each via the
 * shared frontmatter schema, and return action descriptors. Broken skills
 * surface in `errors[]` instead of crashing the panel — same pattern as
 * `GET /api/profiles`'s `ok: false` mode.
 */
export async function discoverEmailActions(
  skillsDir: string,
): Promise<EmailActionDiscovery> {
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return { actions: [], errors: [] }
    }
    throw err
  }
  const actions: EmailActionDescriptor[] = []
  const errors: Array<{ skill: string; error: string }> = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const skillMd = join(skillsDir, ent.name, 'SKILL.md')
    let raw: string
    try {
      raw = await readFile(skillMd, 'utf-8')
    } catch {
      errors.push({ skill: ent.name, error: 'SKILL.md missing' })
      continue
    }
    const parsed = parseFrontmatter(raw)
    const validated = SkillFrontmatterSchema.safeParse(parsed.frontmatter)
    if (!validated.success) {
      errors.push({ skill: ent.name, error: validated.error.message })
      continue
    }
    const fm = validated.data
    actions.push({
      name: fm.name,
      label: fm.label ?? titleCase(fm.name),
      description: fm.description,
      icon: fm.icon ?? null,
      defaultProfile: fm.default_profile ?? null,
      requiresConfirmation: fm.requires_confirmation ?? false,
      surface: fm.surface ?? 'ask_agent',
      tabs: fm.tabs ?? [],
    })
  }
  actions.sort((a, b) => a.name.localeCompare(b.name))
  return { actions, errors }
}

function titleCase(kebab: string): string {
  return kebab
    .split('-')
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

/**
 * Render the simple `{{path.to.value}}` placeholders we support. Not a full
 * Mustache implementation — no sections, no partials, no escaping logic.
 * Templates that need richer rendering should be handled inside the Skill
 * itself.
 */
export function renderTemplate(
  template: string,
  scope: Record<string, unknown>,
): string {
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

/**
 * Mount `GET /api/v1/email/actions` (discovery, cached by skillsDir mtime)
 * and `POST /api/v1/email/actions` (dispatch via `Orchestrator.spawnSession`).
 *
 * The dispatcher loads the email entity, renders the Skill's
 * `prompt_template` against `{ email, args, contextId }`, and spawns a
 * session under the Skill's `default_profile` (falling back to the boot
 * profile).
 */
export async function registerEmailActions(
  app: FastifyInstance,
  deps: RegisterEmailActionsDeps,
): Promise<void> {
  const { service, orchestrator, skillsDir } = deps

  app.get('/api/v1/email/actions', async () => {
    let mtimeMs: number
    try {
      const s = await stat(skillsDir)
      mtimeMs = s.mtimeMs
    } catch {
      // Skills dir missing — no actions.
      return { actions: [], errors: [] }
    }
    if (discoveryCache && discoveryCache.mtimeMs === mtimeMs) {
      return discoveryCache.result
    }
    const result = await discoverEmailActions(skillsDir)
    discoveryCache = { mtimeMs, result }
    return result
  })

  app.post('/api/v1/email/actions', async (req, reply) => {
    const body = DispatchBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    const email = service.getEmail(body.data.emailId)
    if (!email) {
      reply.code(404)
      return { error: 'EMAIL_NOT_FOUND' }
    }
    const skill = await loadActionFrontmatter(skillsDir, body.data.action)
    if (!skill) {
      reply.code(404)
      return { error: 'UNKNOWN_ACTION', action: body.data.action }
    }
    const scope = {
      email: serializeEmail(email),
      contextId: body.data.emailId,
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
    const spawnInput: Parameters<typeof orchestrator.spawnSession>[0] = {
      spawnedBy: `modules/email/${body.data.action}`,
      initialMessage: seedMessage,
      title: skill.fm.label ?? body.data.action,
    }
    if (skill.fm.default_profile) {
      spawnInput.agentProfile = skill.fm.default_profile
    }
    const result = await orchestrator.spawnSession(spawnInput)
    // Drain the stream in the background so the route returns immediately
    // and the client subscribes via WebSocket.
    void (async () => {
      try {
        for await (const _ of result.handle.stream) {
          // discard
        }
      } catch {
        // The orchestrator emits failure events; nothing more to do here.
      }
    })()
    return { sessionId: result.session.id, action: body.data.action }
  })
}

/** Light JSON-safe view of the Email row for template rendering. We expose
 *  only the fields actions are likely to interpolate; richer access can be
 *  granted later by extending the scope object. */
function serializeEmail(e: Email): Record<string, unknown> {
  return {
    id: e.id,
    sourceKind: e.sourceKind,
    sourceId: e.sourceId,
    receivedAt: e.receivedAt,
    fromAddress: e.fromAddress,
    fromName: e.fromName,
    subject: e.subject,
    snippet: e.snippet,
    hasAttachments: e.hasAttachments,
    filedProjectId: e.filedProjectId,
  }
}

/** Test hook — discoveryCache is module-scoped. */
export function __resetDiscoveryCache(): void {
  discoveryCache = null
}

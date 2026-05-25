import { stat } from 'node:fs/promises'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { Orchestrator } from '../../../src/orchestrator/turn.js'
import type { EventBus } from '../../../src/core/events.js'
import {
  discoverActions,
  type ActionDiscovery,
} from '../../../src/modules/action-discovery.js'
import {
  registerModuleActionDispatch,
  renderTemplate as renderTemplateShared,
} from '../../../src/modules/action-dispatch.js'
import type { Email, EmailService } from './service.js'

/**
 * Email-specific bits of action discovery + dispatch. ADR-0007's canonical
 * `GET /api/email/actions` is mounted globally via `registerModuleActionsDiscovery`.
 * This file mounts the legacy `GET /api/v1/email/actions` (for clients that
 * still hit the v1 path) and the POST dispatcher, which differs from the
 * generic only by:
 *   1. accepting `emailId` alongside `contextId` (back-compat),
 *   2. resolving the entity via `EmailService.getEmail`,
 *   3. emitting `email.action_started` / `email.action_completed`,
 *   4. exposing a fuller `email` scope object for prompt templates.
 */

// Legacy + canonical body shape — both `emailId` (deprecated) and `contextId`
// are accepted. `.transform` projects either into the canonical shape the
// shared dispatcher expects.
const EmailDispatchBody = z
  .object({
    action: z.string().regex(/^[a-z0-9-]+$/),
    emailId: z.string().min(1).optional(),
    contextId: z.string().min(1).optional(),
    args: z.record(z.unknown()).optional(),
  })
  .refine((b) => b.emailId !== undefined || b.contextId !== undefined, {
    message: 'Either contextId or emailId is required',
  })
  .transform((b) => ({
    action: b.action,
    contextId: (b.contextId ?? b.emailId) as string,
    args: b.args ?? {},
  }))

export interface RegisterEmailActionsDeps {
  service: EmailService
  orchestrator: Orchestrator
  /** Absolute path to `modules/email/skills/`. */
  skillsDir: string
  /** Required to emit `email.action_started` / `email.action_completed`. */
  eventBus?: EventBus
}

interface CachedDiscovery {
  mtimeMs: number
  result: ActionDiscovery
}

let legacyDiscoveryCache: CachedDiscovery | null = null

/**
 * Back-compat wrapper used by `tests/email-skills.test.ts` and any callers
 * importing it directly. Identical to `discoverActions({ skillsDir })`.
 */
export async function discoverEmailActions(skillsDir: string): Promise<ActionDiscovery> {
  return discoverActions({ skillsDir })
}

/** @deprecated Use `renderTemplate` from `src/modules/action-dispatch.ts`. */
export const renderTemplate = renderTemplateShared

/** Test hook — clears the legacy v1 discovery cache. */
export function __resetDiscoveryCache(): void {
  legacyDiscoveryCache = null
}

/**
 * Mount the legacy `GET /api/v1/email/actions` discovery path and both
 * dispatcher URLs. The canonical `GET /api/email/actions` is registered
 * globally per ADR-0007.
 */
export async function registerEmailActions(
  app: FastifyInstance,
  deps: RegisterEmailActionsDeps,
): Promise<void> {
  app.get('/api/v1/email/actions', async () => {
    let mtimeMs: number
    try {
      const s = await stat(deps.skillsDir)
      mtimeMs = s.mtimeMs
    } catch {
      return { actions: [], errors: [] }
    }
    if (legacyDiscoveryCache && legacyDiscoveryCache.mtimeMs === mtimeMs) {
      return legacyDiscoveryCache.result
    }
    const result = await discoverActions({ skillsDir: deps.skillsDir })
    legacyDiscoveryCache = { mtimeMs, result }
    return result
  })

  await registerModuleActionDispatch<Email, z.output<typeof EmailDispatchBody>>(app, {
    module: 'email',
    urls: ['/api/v1/email/actions', '/api/email/actions'],
    skillsDir: deps.skillsDir,
    orchestrator: deps.orchestrator,
    body: EmailDispatchBody,
    lookup: (contextId) => deps.service.getEmail(contextId) ?? null,
    notFoundError: 'EMAIL_NOT_FOUND',
    scopeBuilder: (email, contextId, args) => ({
      email: serializeEmail(email),
      contextId,
      args,
    }),
    events: deps.eventBus
      ? {
          bus: deps.eventBus,
          onStarted: ({ contextId, action, sessionId }) => ({
            type: 'email.action_started',
            emailId: contextId,
            action,
            sessionId,
            ts: Date.now(),
          }),
          onCompleted: ({ contextId, action, sessionId, ok }) => ({
            type: 'email.action_completed',
            emailId: contextId,
            action,
            sessionId,
            ok,
            ts: Date.now(),
          }),
        }
      : undefined,
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

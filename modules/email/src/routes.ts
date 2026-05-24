import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { EmailSource } from './source.js'
import type { ActorContext, EmailService } from './service.js'

const ListQuery = z.object({
  isRead: z.coerce.boolean().optional(),
  filed: z.coerce.boolean().optional(),
  hasAttachments: z.coerce.boolean().optional(),
  projectId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
})

const EmailIdParams = z.object({ id: z.string().min(1) })

const PatchEmailBody = z.object({
  isRead: z.boolean().optional(),
})

const HTTP_ACTOR: ActorContext = { actor: { type: 'user' } }

export interface RegisterEmailRoutesDeps {
  service: EmailService
  /** Optional. When provided, `POST /api/email/poll` calls source.list()
   *  and ingests new messages. Without it, the route returns 503. */
  source?: EmailSource
}

export async function registerEmailRoutes(
  app: FastifyInstance,
  deps: RegisterEmailRoutesDeps,
): Promise<void> {
  const { service, source } = deps

  // ADR-0007 / P3P1: mount handlers under both the v1 prefix (back-compat
  // for callers that hard-coded /api/v1/email) and the canonical no-prefix
  // path. Frontend code uses the canonical path.
  function bothPaths(suffix: string): string[] {
    return [`/api/v1/email${suffix}`, `/api/email${suffix}`]
  }

  for (const url of bothPaths('')) {
    app.get(url, async (req, reply) => {
      const parsed = ListQuery.safeParse(req.query ?? {})
      if (!parsed.success) {
        reply.code(400)
        return { error: 'INVALID_QUERY', details: parsed.error.flatten() }
      }
      const opts: Parameters<typeof service.listEmails>[0] = {}
      if (parsed.data.isRead !== undefined) opts.isRead = parsed.data.isRead
      if (parsed.data.filed !== undefined) opts.filed = parsed.data.filed
      if (parsed.data.hasAttachments !== undefined)
        opts.hasAttachments = parsed.data.hasAttachments
      if (parsed.data.projectId !== undefined) opts.projectId = parsed.data.projectId
      if (parsed.data.limit !== undefined) opts.limit = parsed.data.limit
      return { emails: service.listEmails(opts) }
    })
  }

  for (const url of bothPaths('/:id')) {
    app.get(url, async (req, reply) => {
      const params = EmailIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const email = service.getEmail(params.data.id)
      if (!email) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      return { email }
    })
  }

  // --- GET /api/email/:id/body (P3P2) ---
  for (const url of bothPaths('/:id/body')) {
    app.get(url, async (req, reply) => {
      const params = EmailIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const email = service.getEmail(params.data.id)
      if (!email) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      if (!source) {
        reply.code(503)
        return { error: 'NO_EMAIL_SOURCE_CONFIGURED' }
      }
      try {
        let body
        if (source.getBody) {
          body = await source.getBody(email.sourceId)
        } else {
          // Fall back to the older `.get()` shape — produces plain text.
          const detail = await source.get(email.sourceId)
          body = {
            kind: 'text' as const,
            content: detail.body,
            attachments: detail.attachmentNames.map((filename) => ({
              filename,
              bytes: 0,
              contentType: null,
            })),
          }
        }
        return {
          emailId: email.id,
          ...body,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (/not found|ENOENT/i.test(message)) {
          reply.code(404)
          return { error: 'NOT_FOUND_IN_SOURCE', message }
        }
        reply.code(503)
        return { error: 'SOURCE_ERROR', message }
      }
    })
  }

  // --- GET /api/email/:id/attachments/:name (P3P4) ---
  for (const base of ['/api/v1/email', '/api/email']) {
    app.get(`${base}/:id/attachments/:name`, async (req, reply) => {
      const params = z
        .object({ id: z.string().min(1), name: z.string().min(1) })
        .safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const email = service.getEmail(params.data.id)
      if (!email) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      if (!source) {
        reply.code(503)
        return { error: 'NO_EMAIL_SOURCE_CONFIGURED' }
      }
      // Reject path-traversal attempts in the attachment name. The route
      // param is bound to a single segment but a sender-controlled filename
      // could still contain `..` if a future source reused that string.
      if (params.data.name.includes('/') || params.data.name.includes('\\') || params.data.name.includes('..')) {
        reply.code(400)
        return { error: 'INVALID_ATTACHMENT_NAME' }
      }
      try {
        const buf = await source.fetchAttachment(email.sourceId, params.data.name)
        const safeName = params.data.name.replace(/[^\w.\-+ ]+/g, '_')
        reply.header('Content-Type', 'application/octet-stream')
        reply.header(
          'Content-Disposition',
          `attachment; filename="${safeName}"`,
        )
        return reply.send(buf)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (/not found|ENOENT|does not support/i.test(message)) {
          reply.code(404)
          return { error: 'ATTACHMENT_NOT_FOUND', message }
        }
        reply.code(503)
        return { error: 'SOURCE_ERROR', message }
      }
    })
  }

  for (const url of bothPaths('/:id')) {
    app.patch(url, async (req, reply) => {
      const params = EmailIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = PatchEmailBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      if (body.data.isRead === undefined) {
        reply.code(400)
        return { error: 'NO_FIELDS_TO_UPDATE' }
      }
      try {
        service.markRead(params.data.id, body.data.isRead, HTTP_ACTOR)
      } catch {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      return { email: service.getEmail(params.data.id) }
    })
  }

  for (const url of bothPaths('/poll')) {
    app.post(url, async (_req, reply) => {
      if (!source) {
        reply.code(503)
        return { error: 'NO_EMAIL_SOURCE_CONFIGURED' }
      }
      const result = await service.pollSource(source, {
        actor: { type: 'scheduler', id: 'email-poll' },
      })
      return result
    })
  }

  // POST /api/email/:id/file-to-project was retired in favour of action
  // dispatch (POST /api/email/actions { action: 'file-to-project' }) — see
  // ADR-0007 + modules/email/src/actions.ts.
}

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

const FileToProjectBody = z.object({
  projectId: z.string().min(1),
  body: z.string(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        /** Base64 contents. The route decodes before passing to the service. */
        contentBase64: z.string(),
      }),
    )
    .optional(),
})

const HTTP_ACTOR: ActorContext = { actor: { type: 'user' } }

export interface RegisterEmailRoutesDeps {
  service: EmailService
  /** Optional. When provided, `POST /api/v1/email/poll` calls source.list()
   *  and ingests new messages. Without it, the route returns 503. */
  source?: EmailSource
}

export async function registerEmailRoutes(
  app: FastifyInstance,
  deps: RegisterEmailRoutesDeps,
): Promise<void> {
  const { service, source } = deps

  app.get('/api/v1/email', async (req, reply) => {
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

  app.get('/api/v1/email/:id', async (req, reply) => {
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

  app.patch('/api/v1/email/:id', async (req, reply) => {
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
      // No-op; let the client choose explicitly to avoid silent partial PATCH.
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

  app.post('/api/v1/email/poll', async (_req, reply) => {
    if (!source) {
      reply.code(503)
      return { error: 'NO_EMAIL_SOURCE_CONFIGURED' }
    }
    const result = await service.pollSource(source, {
      actor: { type: 'scheduler', id: 'email-poll' },
    })
    return result
  })

  app.post('/api/v1/email/:id/file-to-project', async (req, reply) => {
    const params = EmailIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = FileToProjectBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    try {
      const fileInput: Parameters<typeof service.fileToProject>[0] = {
        emailId: params.data.id,
        projectId: body.data.projectId,
        body: body.data.body,
      }
      if (body.data.attachments && body.data.attachments.length > 0) {
        fileInput.attachments = body.data.attachments.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.contentBase64, 'base64'),
        }))
      }
      const result = await service.fileToProject(fileInput, HTTP_ACTOR)
      return { folderPath: result.folderPath, email: service.getEmail(params.data.id) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/already filed/i.test(message)) {
        reply.code(409)
        return { error: 'ALREADY_FILED', message }
      }
      if (/email not found/i.test(message)) {
        reply.code(404)
        return { error: 'EMAIL_NOT_FOUND', message }
      }
      if (/project not found/i.test(message)) {
        reply.code(404)
        return { error: 'PROJECT_NOT_FOUND', message }
      }
      reply.code(400)
      return { error: 'FILE_TO_PROJECT_FAILED', message }
    }
  })
}

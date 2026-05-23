import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  type ActorContext,
  type EstimateStatus,
  type LineKind,
  type ProposalsService,
  type ProposalStatus,
} from './service.js'

const LineKindEnum: z.ZodType<LineKind> = z.enum(['fixed', 'time_and_materials', 'unit'])
const EstimateStatusEnum: z.ZodType<EstimateStatus> = z.enum([
  'draft',
  'ready',
  'accepted',
  'rejected',
  'superseded',
])
const ProposalStatusEnum: z.ZodType<ProposalStatus> = z.enum([
  'draft',
  'issued',
  'accepted',
  'rejected',
  'superseded',
])

const CreateEstimateBody = z.object({
  sourceScopePath: z.string().optional(),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  lines: z.array(
    z.object({
      kind: LineKindEnum.optional(),
      description: z.string().min(1),
      qty: z.number().nonnegative().optional(),
      unit: z.string().optional(),
      unitPrice: z.number().nonnegative().optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
  ),
})

const CreateProposalBody = z.object({
  estimateId: z.string().min(1),
  templateName: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

const ProjectIdParams = z.object({ projectId: z.string().min(1) })
const EstimateIdParams = z.object({ id: z.string().min(1) })
const ProposalIdParams = z.object({ id: z.string().min(1) })

const PatchEstimateStatusBody = z.object({ status: EstimateStatusEnum })
const PatchProposalStatusBody = z.object({ status: ProposalStatusEnum })

const HTTP_ACTOR: ActorContext = { actor: { type: 'user' } }

export interface RegisterProposalsRoutesDeps {
  service: ProposalsService
}

export async function registerProposalsRoutes(
  app: FastifyInstance,
  deps: RegisterProposalsRoutesDeps,
): Promise<void> {
  const { service } = deps

  app.post('/api/v1/projects/:projectId/estimates', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = CreateEstimateBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    try {
      const estimate = service.createEstimate(
        { projectId: params.data.projectId, ...body.data },
        HTTP_ACTOR,
      )
      reply.code(201)
      return { estimate }
    } catch (err) {
      reply.code(400)
      return {
        error: 'CREATE_ESTIMATE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }
    }
  })

  app.get('/api/v1/projects/:projectId/estimates', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    return { estimates: service.listEstimatesForProject(params.data.projectId) }
  })

  app.get('/api/v1/estimates/:id', async (req, reply) => {
    const params = EstimateIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const estimate = service.getEstimate(params.data.id)
    if (!estimate) {
      reply.code(404)
      return { error: 'NOT_FOUND' }
    }
    return { estimate }
  })

  app.patch('/api/v1/estimates/:id/status', async (req, reply) => {
    const params = EstimateIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = PatchEstimateStatusBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    try {
      service.setEstimateStatus(params.data.id, body.data.status, HTTP_ACTOR)
    } catch {
      reply.code(404)
      return { error: 'NOT_FOUND' }
    }
    return { estimate: service.getEstimate(params.data.id) }
  })

  app.post('/api/v1/projects/:projectId/proposals', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = CreateProposalBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    try {
      const createInput: Parameters<typeof service.createProposal>[0] = {
        projectId: params.data.projectId,
        estimateId: body.data.estimateId,
      }
      if (body.data.templateName !== undefined) createInput.templateName = body.data.templateName
      if (body.data.metadata !== undefined) createInput.metadata = body.data.metadata
      const proposal = await service.createProposal(createInput, HTTP_ACTOR)
      reply.code(201)
      return { proposal }
    } catch (err) {
      reply.code(400)
      return {
        error: 'CREATE_PROPOSAL_FAILED',
        message: err instanceof Error ? err.message : String(err),
      }
    }
  })

  app.get('/api/v1/projects/:projectId/proposals', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    return { proposals: service.listProposalsForProject(params.data.projectId) }
  })

  app.get('/api/v1/proposals/:id', async (req, reply) => {
    const params = ProposalIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const proposal = service.getProposal(params.data.id)
    if (!proposal) {
      reply.code(404)
      return { error: 'NOT_FOUND' }
    }
    return { proposal }
  })

  app.patch('/api/v1/proposals/:id/status', async (req, reply) => {
    const params = ProposalIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = PatchProposalStatusBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    try {
      service.setProposalStatus(params.data.id, body.data.status, HTTP_ACTOR)
    } catch {
      reply.code(404)
      return { error: 'NOT_FOUND' }
    }
    return { proposal: service.getProposal(params.data.id) }
  })
}

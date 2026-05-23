import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  DuplicateProjectNumberError,
  type ActorContext,
  type EntityStatus,
  type ProjectsService,
} from './service.js'

const StatusEnum = z.enum(['pending', 'active', 'blocked', 'completed', 'cancelled'])

const CreateProjectBody = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  client: z.string().optional(),
  description: z.string().optional(),
  folderPath: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

const ListQuery = z.object({
  status: z
    .union([StatusEnum, z.array(StatusEnum)])
    .optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
})

const ProjectIdParams = z.object({ id: z.string().min(1) })

const PatchStatusBody = z.object({ status: StatusEnum })

const AddPhaseBody = z.object({
  name: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
})

const AddTaskBody = z.object({
  phaseId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  parentTaskId: z.string().optional(),
  assigneeProfile: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

/**
 * HTTP-side actor for routes called by the local UI. Single-user, single-host
 * so we record everything as the user. If the routes are ever opened to other
 * processes we'd thread an authenticated identity through here.
 */
const HTTP_ACTOR: ActorContext = { actor: { type: 'user' } }

export interface RegisterProjectsRoutesDeps {
  service: ProjectsService
}

export async function registerProjectsRoutes(
  app: FastifyInstance,
  deps: RegisterProjectsRoutesDeps,
): Promise<void> {
  const { service } = deps

  app.post('/api/v1/projects', async (req, reply) => {
    const parsed = CreateProjectBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: parsed.error.flatten() }
    }
    try {
      const project = service.createProject(parsed.data, HTTP_ACTOR)
      reply.code(201)
      return { project }
    } catch (err) {
      if (err instanceof DuplicateProjectNumberError) {
        reply.code(409)
        return {
          error: 'DUPLICATE_PROJECT_NUMBER',
          message: err.message,
          number: err.number,
        }
      }
      throw err
    }
  })

  app.get('/api/v1/projects', async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: 'INVALID_QUERY', details: parsed.error.flatten() }
    }
    const status =
      parsed.data.status === undefined
        ? undefined
        : Array.isArray(parsed.data.status)
          ? parsed.data.status
          : [parsed.data.status]
    const limit = parsed.data.limit
    const opts: { status?: EntityStatus[]; limit?: number } = {}
    if (status !== undefined) opts.status = status
    if (limit !== undefined) opts.limit = limit
    const projects = service.listProjects(opts)
    return { projects }
  })

  app.get('/api/v1/projects/:id', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const project = service.getProject(params.data.id)
    if (!project) {
      reply.code(404)
      return { error: 'NOT_FOUND' }
    }
    return {
      project,
      phases: service.listPhases(project.id),
      tasks: service.listTasks(project.id),
    }
  })

  app.patch('/api/v1/projects/:id/status', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = PatchStatusBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    try {
      service.setProjectStatus(params.data.id, body.data.status, HTTP_ACTOR)
    } catch {
      reply.code(404)
      return { error: 'NOT_FOUND' }
    }
    const project = service.getProject(params.data.id)
    return { project }
  })

  app.post('/api/v1/projects/:id/phases', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = AddPhaseBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    if (!service.getProject(params.data.id)) {
      reply.code(404)
      return { error: 'NOT_FOUND' }
    }
    const addPhaseInput: Parameters<typeof service.addPhase>[0] = {
      projectId: params.data.id,
      name: body.data.name,
    }
    if (body.data.metadata !== undefined) addPhaseInput.metadata = body.data.metadata
    const phase = service.addPhase(addPhaseInput, HTTP_ACTOR)
    reply.code(201)
    return { phase }
  })

  app.post('/api/v1/projects/:id/tasks', async (req, reply) => {
    const params = ProjectIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'INVALID_PARAMS' }
    }
    const body = AddTaskBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID_BODY', details: body.error.flatten() }
    }
    if (!service.getProject(params.data.id)) {
      reply.code(404)
      return { error: 'NOT_FOUND' }
    }
    try {
      const taskInput: Parameters<typeof service.addTask>[0] = {
        projectId: params.data.id,
        phaseId: body.data.phaseId,
        title: body.data.title,
      }
      if (body.data.description !== undefined) taskInput.description = body.data.description
      if (body.data.parentTaskId !== undefined) taskInput.parentTaskId = body.data.parentTaskId
      if (body.data.assigneeProfile !== undefined)
        taskInput.assigneeProfile = body.data.assigneeProfile
      if (body.data.metadata !== undefined) taskInput.metadata = body.data.metadata
      const task = service.addTask(taskInput, HTTP_ACTOR)
      reply.code(201)
      return { task }
    } catch (err) {
      reply.code(400)
      return { error: 'INVALID_TASK', message: err instanceof Error ? err.message : String(err) }
    }
  })
}

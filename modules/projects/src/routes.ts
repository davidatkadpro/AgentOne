import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { readdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { confineToRoot, isSafeRelativePath } from '../../../src/storage/path-confine.js'
import { mapDomainError } from '../../../src/errors/domain.js'
import {
  DuplicateProjectNumberError,
  TaskDependencyCycleError,
  type ActorContext,
  type BlockedActorContext,
  type EntityStatus,
  type ProjectsService,
} from './service.js'
import type { AuditLog } from '../../../src/modules/audit-log.js'

const StatusEnum = z.enum(['pending', 'active', 'blocked', 'completed', 'cancelled'])
const PriorityEnum = z.enum(['low', 'normal', 'high', 'urgent'])

// Task date columns are unix-ms; cap absurd values so a 10-digit-second value
// doesn't silently land as a year-1970 timestamp. 2100-01-01 is a generous
// upper bound that still catches accidental second-precision integers
// (1.7e9 < this).
const Timestamp = z.number().int().min(0).max(4102444800000)
// `time` columns are minute counts. 100 years of minutes is ~52,560,000, but
// individual tasks shouldn't exceed a few thousand. Cap at a million as a
// safety net against typos turning seconds into minutes.
const Minutes = z.number().int().min(0).max(1_000_000)

const CreateProjectBody = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  client: z.string().optional(),
  description: z.string().optional(),
  folderPath: z
    .string()
    .refine(isSafeRelativePath, {
      message:
        'folderPath must be a relative POSIX path, no `..`, no drive letters, no absolute paths',
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
})

const ListQuery = z.object({
  status: z
    .union([StatusEnum, z.array(StatusEnum)])
    .optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
})

const ProjectIdParams = z.object({ id: z.string().min(1) })
const TaskIdParams = z.object({ id: z.string().min(1) })
const PhaseIdParams = z.object({ id: z.string().min(1) })

const PatchStatusBody = z.object({ status: StatusEnum })

const UpdateProjectBody = z
  .object({
    name: z.string().min(1).optional(),
    client: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Empty body' })

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
  startDate: Timestamp.optional(),
  dueDate: Timestamp.optional(),
  estimatedMinutes: Minutes.optional(),
  priority: PriorityEnum.optional(),
  metadata: z.record(z.unknown()).optional(),
})

const UpdateTaskBody = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: StatusEnum.optional(),
    assigneeProfile: z.string().nullable().optional(),
    parentTaskId: z.string().nullable().optional(),
    startDate: Timestamp.nullable().optional(),
    dueDate: Timestamp.nullable().optional(),
    estimatedMinutes: Minutes.nullable().optional(),
    spentMinutes: Minutes.optional(),
    priority: PriorityEnum.optional(),
    reason: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Empty body' })

const AttachFileBody = z.object({
  filePath: z.string().min(1).refine(isSafeRelativePath, {
    message:
      'filePath must be a relative POSIX path (no `..`, no drive letters, no absolute paths)',
  }),
  label: z.string().max(200).nullable().optional(),
})

const DetachFileBody = z.object({
  filePath: z.string().min(1).refine(isSafeRelativePath, {
    message:
      'filePath must be a relative POSIX path (no `..`, no drive letters, no absolute paths)',
  }),
})

const UpdatePhaseBody = z
  .object({
    name: z.string().min(1).optional(),
    status: StatusEnum.optional(),
    position: z.number().int().min(0).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Empty body' })

const AddDependencyBody = z.object({ dependsOnTaskId: z.string().min(1) })
const DependencyParams = z.object({
  id: z.string().min(1),
  dependsOnTaskId: z.string().min(1),
})

const ActivityQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

/**
 * HTTP-side actor for routes called by the local UI. Single-user, single-host
 * so we record everything as the user. If the routes are ever opened to other
 * processes we'd thread an authenticated identity through here.
 */
const HTTP_ACTOR: ActorContext = { actor: { type: 'user' } }

export interface RegisterProjectsRoutesDeps {
  service: ProjectsService
  /** Optional. When present, /api/projects/:id/activity uses it; without it the
   *  activity endpoint returns 503. The Phase 1.5 server passes the
   *  application's AuditLog. Tests can omit it when activity isn't exercised. */
  audit?: AuditLog
  /** Absolute path to the storage root (folder that contains `projects/`).
   *  Required for /scope and /files routes; tests can omit when not exercised. */
  storageRoot?: string
}

export async function registerProjectsRoutes(
  app: FastifyInstance,
  deps: RegisterProjectsRoutesDeps,
): Promise<void> {
  const { service, audit, storageRoot } = deps

  // The handler bodies are written once and registered under BOTH the v1
  // and the no-prefix paths. ADR-0007 convention is `/api/<module>/...`;
  // the v1 prefix stays for older callers (P2P1).

  function bothPaths(suffix: string): string[] {
    return [`/api/v1/projects${suffix}`, `/api/projects${suffix}`]
  }

  // --- POST /api/projects ---
  for (const url of bothPaths('')) {
    app.post(url, async (req, reply) => {
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
  }

  // --- GET /api/projects/next-number ---
  // Mounted before the `/:id` listing so the literal segment wins.
  for (const url of [
    `/api/v1/projects/next-number`,
    `/api/projects/next-number`,
  ]) {
    app.get(url, async () => ({ number: service.suggestNextNumber() }))
  }

  // --- GET /api/projects ---
  for (const url of bothPaths('')) {
    app.get(url, async (req, reply) => {
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
  }

  // --- GET /api/projects/:id ---
  for (const url of bothPaths('/:id')) {
    app.get(url, async (req, reply) => {
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
      const tasks = service.listTasks(project.id)
      const taskFiles = tasks.flatMap((t) => service.listTaskFiles(t.id))
      return {
        project,
        phases: service.listPhases(project.id),
        tasks,
        dependencies: service.listAllDependencies(project.id),
        taskFiles,
      }
    })
  }

  // --- PATCH /api/projects/:id ---
  for (const url of bothPaths('/:id')) {
    app.patch(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = UpdateProjectBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        const update: Parameters<typeof service.updateProject>[0] = {
          projectId: params.data.id,
        }
        if (body.data.name !== undefined) update.name = body.data.name
        if (body.data.client !== undefined) update.client = body.data.client
        if (body.data.description !== undefined) update.description = body.data.description
        const project = service.updateProject(update, HTTP_ACTOR)
        return { project }
      } catch (err) {
        const mapped = mapDomainError(err)
        if (mapped) {
          reply.code(mapped.status)
          return mapped.body
        }
        throw err
      }
    })
  }

  // --- PATCH /api/projects/:id/status ---
  for (const url of bothPaths('/:id/status')) {
    app.patch(url, async (req, reply) => {
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
      } catch (err) {
        const mapped = mapDomainError(err)
        if (mapped) {
          reply.code(mapped.status)
          return mapped.body
        }
        throw err
      }
      const project = service.getProject(params.data.id)
      return { project }
    })
  }

  // --- POST /api/projects/:id/phases ---
  for (const url of bothPaths('/:id/phases')) {
    app.post(url, async (req, reply) => {
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
  }

  // --- POST /api/projects/:id/tasks ---
  for (const url of bothPaths('/:id/tasks')) {
    app.post(url, async (req, reply) => {
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
        if (body.data.startDate !== undefined) taskInput.startDate = body.data.startDate
        if (body.data.dueDate !== undefined) taskInput.dueDate = body.data.dueDate
        if (body.data.estimatedMinutes !== undefined)
          taskInput.estimatedMinutes = body.data.estimatedMinutes
        if (body.data.priority !== undefined) taskInput.priority = body.data.priority
        if (body.data.metadata !== undefined) taskInput.metadata = body.data.metadata
        const task = service.addTask(taskInput, HTTP_ACTOR)
        reply.code(201)
        return { task }
      } catch (err) {
        const mapped = mapDomainError(err)
        if (mapped) {
          reply.code(mapped.status)
          return mapped.body
        }
        reply.code(400)
        return { error: 'INVALID_TASK', message: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  // --- PATCH /api/tasks/:id (P2P2) ---
  for (const url of ['/api/v1/tasks/:id', '/api/tasks/:id']) {
    app.patch(url, async (req, reply) => {
      const params = TaskIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = UpdateTaskBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      if (!service.getTask(params.data.id)) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      const ctx: BlockedActorContext = { actor: { type: 'user' } }
      if (body.data.reason !== undefined) ctx.reason = body.data.reason
      try {
        const update: Parameters<typeof service.updateTask>[0] = {
          taskId: params.data.id,
        }
        if (body.data.title !== undefined) update.title = body.data.title
        if (body.data.description !== undefined) update.description = body.data.description
        if (body.data.status !== undefined) update.status = body.data.status
        if (body.data.assigneeProfile !== undefined)
          update.assigneeProfile = body.data.assigneeProfile
        if (body.data.parentTaskId !== undefined) update.parentTaskId = body.data.parentTaskId
        if (body.data.startDate !== undefined) update.startDate = body.data.startDate
        if (body.data.dueDate !== undefined) update.dueDate = body.data.dueDate
        if (body.data.estimatedMinutes !== undefined)
          update.estimatedMinutes = body.data.estimatedMinutes
        if (body.data.spentMinutes !== undefined) update.spentMinutes = body.data.spentMinutes
        if (body.data.priority !== undefined) update.priority = body.data.priority
        const task = service.updateTask(update, ctx)
        return { task }
      } catch (err) {
        const mapped = mapDomainError(err)
        if (mapped) {
          reply.code(mapped.status)
          return mapped.body
        }
        reply.code(400)
        return { error: 'INVALID_UPDATE', message: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  // --- PATCH /api/phases/:id (P2P3) ---
  for (const url of ['/api/v1/phases/:id', '/api/phases/:id']) {
    app.patch(url, async (req, reply) => {
      const params = PhaseIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = UpdatePhaseBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      if (!service.getPhase(params.data.id)) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      try {
        const update: Parameters<typeof service.updatePhase>[0] = {
          phaseId: params.data.id,
        }
        if (body.data.name !== undefined) update.name = body.data.name
        if (body.data.status !== undefined) update.status = body.data.status
        if (body.data.position !== undefined) update.position = body.data.position
        const phase = service.updatePhase(update, HTTP_ACTOR)
        return { phase }
      } catch (err) {
        reply.code(400)
        return { error: 'INVALID_UPDATE', message: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  // --- POST /api/tasks/:id/dependencies (P2P4) ---
  for (const url of ['/api/v1/tasks/:id/dependencies', '/api/tasks/:id/dependencies']) {
    app.post(url, async (req, reply) => {
      const params = TaskIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = AddDependencyBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      if (!service.getTask(params.data.id)) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      if (!service.getTask(body.data.dependsOnTaskId)) {
        reply.code(404)
        return { error: 'DEPENDENCY_NOT_FOUND' }
      }
      try {
        service.setDependency(
          { taskId: params.data.id, dependsOnTaskId: body.data.dependsOnTaskId },
          HTTP_ACTOR,
        )
        reply.code(201)
        return {
          dependency: {
            taskId: params.data.id,
            dependsOnTaskId: body.data.dependsOnTaskId,
          },
        }
      } catch (err) {
        if (err instanceof TaskDependencyCycleError) {
          reply.code(409)
          return {
            error: 'TASK_DEPENDENCY_CYCLE',
            taskId: err.taskId,
            dependsOnTaskId: err.dependsOnTaskId,
          }
        }
        reply.code(400)
        return { error: 'INVALID_DEPENDENCY', message: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  // --- DELETE /api/tasks/:id/dependencies/:dependsOnTaskId (P2P4) ---
  for (const url of [
    '/api/v1/tasks/:id/dependencies/:dependsOnTaskId',
    '/api/tasks/:id/dependencies/:dependsOnTaskId',
  ]) {
    app.delete(url, async (req, reply) => {
      const params = DependencyParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      service.removeDependency(
        { taskId: params.data.id, dependsOnTaskId: params.data.dependsOnTaskId },
        HTTP_ACTOR,
      )
      return { ok: true }
    })
  }

  // --- GET /api/tasks/:id/files ---
  for (const url of ['/api/v1/tasks/:id/files', '/api/tasks/:id/files']) {
    app.get(url, async (req, reply) => {
      const params = TaskIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      if (!service.getTask(params.data.id)) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      const files = service.listTaskFiles(params.data.id)
      return { files }
    })
  }

  // --- POST /api/tasks/:id/files ---
  for (const url of ['/api/v1/tasks/:id/files', '/api/tasks/:id/files']) {
    app.post(url, async (req, reply) => {
      const params = TaskIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = AttachFileBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        const attachInput: Parameters<typeof service.attachTaskFile>[0] = {
          taskId: params.data.id,
          filePath: body.data.filePath,
        }
        if (body.data.label !== undefined) attachInput.label = body.data.label
        const file = service.attachTaskFile(attachInput, HTTP_ACTOR)
        reply.code(201)
        return { file }
      } catch (err) {
        const mapped = mapDomainError(err)
        if (mapped) {
          reply.code(mapped.status)
          return mapped.body
        }
        throw err
      }
    })
  }

  // --- DELETE /api/tasks/:id/files (body carries filePath) ---
  for (const url of ['/api/v1/tasks/:id/files', '/api/tasks/:id/files']) {
    app.delete(url, async (req, reply) => {
      const params = TaskIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = DetachFileBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        service.detachTaskFile(
          { taskId: params.data.id, filePath: body.data.filePath },
          HTTP_ACTOR,
        )
        return { ok: true }
      } catch (err) {
        const mapped = mapDomainError(err)
        if (mapped) {
          reply.code(mapped.status)
          return mapped.body
        }
        throw err
      }
    })
  }

  // --- GET /api/projects/:id/activity (P2P6) ---
  for (const url of bothPaths('/:id/activity')) {
    app.get(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      if (!service.getProject(params.data.id)) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      if (!audit) {
        reply.code(503)
        return { error: 'AUDIT_UNAVAILABLE' }
      }
      const q = ActivityQuery.safeParse(req.query ?? {})
      if (!q.success) {
        reply.code(400)
        return { error: 'INVALID_QUERY', details: q.error.flatten() }
      }
      const opts: { limit?: number; offset?: number } = {}
      if (q.data.limit !== undefined) opts.limit = q.data.limit
      if (q.data.offset !== undefined) opts.offset = q.data.offset
      const { entries, hasMore } = audit.listByProject(params.data.id, opts)
      const mapped = entries.map((e) => ({
        id: e.id,
        ts: e.ts,
        actorKind: e.actor.type,
        actorId:
          e.actor.type === 'agent'
            ? e.actor.sessionId
            : e.actor.type === 'scheduler' || e.actor.type === 'hook'
              ? e.actor.id
              : e.actor.type === 'module'
                ? e.actor.module
                : null,
        module: e.module,
        action: e.action,
        targetId: e.entityId,
        details: (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<
          string,
          unknown
        >,
      }))
      return { entries: mapped, hasMore }
    })
  }

  // --- GET /api/projects/:id/scope (P2P7) ---
  for (const url of bothPaths('/:id/scope')) {
    app.get(url, async (req, reply) => {
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
      if (!project.folderPath || !storageRoot) {
        return { path: null, markdown: null, generatedAt: null }
      }
      const inDir = confineToRoot(storageRoot, `${project.folderPath}/in`)
      if (!inDir) {
        return { path: null, markdown: null, generatedAt: null }
      }
      let subdirs
      try {
        subdirs = await readdir(inDir, { withFileTypes: true })
      } catch {
        return { path: null, markdown: null, generatedAt: null }
      }
      const candidates: Array<{ rel: string; abs: string; mtime: number }> = []
      for (const ent of subdirs) {
        if (!ent.isDirectory()) continue
        const scopePath = join(inDir, ent.name, 'scope.md')
        try {
          const s = await stat(scopePath)
          if (s.isFile()) {
            candidates.push({
              rel: `${project.folderPath}/in/${ent.name}/scope.md`,
              abs: scopePath,
              mtime: s.mtimeMs,
            })
          }
        } catch {
          // not a scope folder; skip
        }
      }
      if (candidates.length === 0) {
        return { path: null, markdown: null, generatedAt: null }
      }
      candidates.sort((a, b) => b.mtime - a.mtime)
      const winner = candidates[0]!
      const md = await readFile(winner.abs, 'utf-8')
      return {
        path: winner.rel,
        markdown: md,
        generatedAt: new Date(winner.mtime).toISOString(),
      }
    })
  }

  // --- GET /api/projects/:id/files (P2P8) ---
  for (const url of bothPaths('/:id/files')) {
    app.get(url, async (req, reply) => {
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
      if (!project.folderPath || !storageRoot) {
        return { rootPath: '', entries: [] }
      }
      const rootAbs = confineToRoot(storageRoot, project.folderPath)
      if (!rootAbs) return { rootPath: '', entries: [] }
      const entries: Array<{
        relativePath: string
        name: string
        kind: 'file' | 'directory'
        bytes: number
        mtime: string
      }> = []
      for (const sub of ['in', 'drafts']) {
        const subAbs = join(rootAbs, sub)
        let items
        try {
          items = await readdir(subAbs, { withFileTypes: true })
        } catch {
          continue
        }
        for (const it of items) {
          const itemAbs = join(subAbs, it.name)
          let s
          try {
            s = await stat(itemAbs)
          } catch {
            continue
          }
          entries.push({
            relativePath: `${sub}/${it.name}`,
            name: it.name,
            kind: it.isDirectory() ? 'directory' : 'file',
            bytes: s.size,
            mtime: new Date(s.mtimeMs).toISOString(),
          })
        }
      }
      // Return the storage-relative folder path rather than the absolute
      // filesystem path. Clients combine `relativePath` entries with this if
      // they need to address files via storage APIs; they should not need
      // the host's absolute layout.
      return { rootPath: project.folderPath, entries }
    })
  }

  // Note: GET /api/projects/:id/budget moved to the invoicing module in
  // Phase 5 — it returns the richer InvoiceBudget shape that includes
  // invoiced + paid totals. See modules/invoicing/src/routes.ts.
}


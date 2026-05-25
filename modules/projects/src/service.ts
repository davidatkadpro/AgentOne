import { randomUUID } from 'node:crypto'
import type { Db } from '../../../src/storage/db.js'
import type { EventBus } from '../../../src/core/events.js'
import type { AuditActor, AuditLog } from '../../../src/modules/audit-log.js'
import type { StorageAdapter } from '../../../src/storage/adapter.js'

import { NotFoundError } from '../../../src/errors/domain.js'

export class DuplicateProjectNumberError extends Error {
  constructor(public readonly number: string) {
    super(`Project number "${number}" is already in use`)
    this.name = 'DuplicateProjectNumberError'
  }
}

export class TaskDependencyCycleError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly dependsOnTaskId: string,
  ) {
    super(
      `Adding dependency ${taskId} → ${dependsOnTaskId} would create a cycle`,
    )
    this.name = 'TaskDependencyCycleError'
  }
}

export type EntityStatus =
  | 'pending'
  | 'active'
  | 'blocked'
  | 'completed'
  | 'cancelled'

export interface Project {
  id: string
  number: string
  name: string
  client: string | null
  description: string | null
  status: EntityStatus
  folderPath: string | null
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

export interface TaskFile {
  taskId: string
  filePath: string
  label: string | null
  createdAt: number
}

export interface Phase {
  id: string
  projectId: string
  name: string
  position: number
  status: EntityStatus
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface CreateProjectInput {
  number: string
  name: string
  client?: string | null
  description?: string | null
  folderPath?: string | null
  metadata?: Record<string, unknown>
}

export interface AddPhaseInput {
  projectId: string
  name: string
  metadata?: Record<string, unknown>
}

export interface Task {
  id: string
  projectId: string
  phaseId: string
  parentTaskId: string | null
  title: string
  description: string | null
  status: EntityStatus
  assigneeProfile: string | null
  position: number
  startDate: number | null
  dueDate: number | null
  estimatedMinutes: number | null
  spentMinutes: number
  priority: TaskPriority
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface AddTaskInput {
  projectId: string
  phaseId: string
  title: string
  description?: string | null
  parentTaskId?: string | null
  assigneeProfile?: string | null
  startDate?: number | null
  dueDate?: number | null
  estimatedMinutes?: number | null
  priority?: TaskPriority
  metadata?: Record<string, unknown>
}

export interface ActorContext {
  actor: AuditActor
}

export interface BlockedActorContext extends ActorContext {
  /** Optional explanation surfaced on `task.blocked` events. */
  reason?: string | null
}

export interface ListProjectsOptions {
  status?: EntityStatus[]
  limit?: number
}

export interface UpdateProjectInput {
  projectId: string
  name?: string
  client?: string | null
  description?: string | null
}

export interface UpdateTaskInput {
  taskId: string
  title?: string
  description?: string | null
  status?: EntityStatus
  assigneeProfile?: string | null
  parentTaskId?: string | null
  startDate?: number | null
  dueDate?: number | null
  estimatedMinutes?: number | null
  spentMinutes?: number
  priority?: TaskPriority
}

export interface AttachTaskFileInput {
  taskId: string
  filePath: string
  label?: string | null
}

export interface DetachTaskFileInput {
  taskId: string
  filePath: string
}

export interface UpdatePhaseInput {
  phaseId: string
  name?: string
  status?: EntityStatus
  position?: number
}

export interface ProjectBudget {
  projectId: string
  budgetCents: number | null
  invoicedCents: number
  paidCents: number
  draftCents: number
}

export interface ProjectsService {
  createProject(input: CreateProjectInput, ctx: ActorContext): Project
  getProject(id: string): Project | undefined
  listProjects(opts?: ListProjectsOptions): Project[]
  addPhase(input: AddPhaseInput, ctx: ActorContext): Phase
  listPhases(projectId: string): Phase[]
  addTask(input: AddTaskInput, ctx: ActorContext): Task
  listTasks(projectId: string): Task[]
  getTask(taskId: string): Task | undefined
  getPhase(phaseId: string): Phase | undefined
  updateProject(input: UpdateProjectInput, ctx: ActorContext): Project
  updateTask(input: UpdateTaskInput, ctx: BlockedActorContext): Task
  updatePhase(input: UpdatePhaseInput, ctx: ActorContext): Phase
  setProjectStatus(id: string, status: EntityStatus, ctx: ActorContext): void
  setPhaseStatus(id: string, status: EntityStatus, ctx: ActorContext): void
  setTaskStatus(id: string, status: EntityStatus, ctx: BlockedActorContext): void
  setDependency(input: TaskDependencyInput, ctx: ActorContext): void
  removeDependency(input: TaskDependencyInput, ctx: ActorContext): void
  getBlockers(taskId: string): Task[]
  listAllDependencies(projectId: string): TaskDependencyInput[]
  attachTaskFile(input: AttachTaskFileInput, ctx: ActorContext): TaskFile
  detachTaskFile(input: DetachTaskFileInput, ctx: ActorContext): void
  listTaskFiles(taskId: string): TaskFile[]
  suggestNextNumber(year?: number): string
  getProjectBudget(projectId: string): ProjectBudget
}

export interface TaskDependencyInput {
  taskId: string
  dependsOnTaskId: string
}

export interface ProjectsServiceDeps {
  db: Db
  eventBus: EventBus
  audit: AuditLog
  /** Optional — when present, createProject eagerly creates the project's
   *  folder tree (`<folderPath>`, `<folderPath>/in`, `<folderPath>/drafts`).
   *  Tests that don't care about the filesystem can omit it. */
  storage?: StorageAdapter
}

interface ProjectRow {
  id: string
  number: string
  name: string
  client: string | null
  description: string | null
  status: string
  folder_path: string | null
  metadata_json: string
  created_at: number
  updated_at: number
  completed_at: number | null
}

interface PhaseRow {
  id: string
  project_id: string
  name: string
  position: number
  status: string
  metadata_json: string
  created_at: number
  updated_at: number
  completed_at: number | null
}

interface TaskRow {
  id: string
  project_id: string
  phase_id: string
  parent_task_id: string | null
  title: string
  description: string | null
  status: string
  assignee_profile: string | null
  position: number
  start_date: number | null
  due_date: number | null
  estimated_minutes: number | null
  spent_minutes: number
  priority: string
  metadata_json: string
  created_at: number
  updated_at: number
  completed_at: number | null
}

interface TaskFileRow {
  task_id: string
  file_path: string
  label: string | null
  created_at: number
}

const VALID_PRIORITIES: ReadonlySet<TaskPriority> = new Set([
  'low',
  'normal',
  'high',
  'urgent',
])

function parsePriority(raw: string): TaskPriority {
  if (VALID_PRIORITIES.has(raw as TaskPriority)) return raw as TaskPriority
  // Unknown values in the DB shouldn't happen because of the column CHECK,
  // but fall back rather than throwing so a single malformed row can't take
  // the whole project list offline.
  return 'normal'
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    status: parseStatus(row.status),
    assigneeProfile: row.assignee_profile,
    position: row.position,
    startDate: row.start_date,
    dueDate: row.due_date,
    estimatedMinutes: row.estimated_minutes,
    spentMinutes: row.spent_minutes,
    priority: parsePriority(row.priority),
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function rowToTaskFile(row: TaskFileRow): TaskFile {
  return {
    taskId: row.task_id,
    filePath: row.file_path,
    label: row.label,
    createdAt: row.created_at,
  }
}

function rowToPhase(row: PhaseRow): Phase {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    position: row.position,
    status: parseStatus(row.status),
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

const VALID_STATUSES: ReadonlySet<EntityStatus> = new Set([
  'pending',
  'active',
  'blocked',
  'completed',
  'cancelled',
])

function parseStatus(raw: string): EntityStatus {
  if (VALID_STATUSES.has(raw as EntityStatus)) return raw as EntityStatus
  throw new Error(`Invalid project status in store: ${raw}`)
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    client: row.client,
    description: row.description,
    status: parseStatus(row.status),
    folderPath: row.folder_path,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

// Filesystem-illegal characters across Windows / macOS / Linux. Collapsed
// whitespace runs to single spaces and trim. Folder structure for a project
// becomes `<number> - <slug>` so an empty slug shouldn't happen in practice;
// fall back to '_' if the caller passed an entirely-illegal name.
function sanitizeSlug(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : '_'
}

function isUniqueViolation(err: unknown, column: string): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: string }).code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message.includes(column)
}

export function createProjectsService(deps: ProjectsServiceDeps): ProjectsService {
  const insertProject = deps.db.prepare(
    `INSERT INTO project
       (id, number, name, client, description, folder_path, metadata_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const getProjectStmt = deps.db.prepare('SELECT * FROM project WHERE id = ?')
  const listAllStmt = deps.db.prepare(
    'SELECT * FROM project ORDER BY created_at DESC, rowid DESC LIMIT ?',
  )
  const listByStatusStmt = deps.db.prepare(
    `SELECT * FROM project
     WHERE status IN (SELECT value FROM json_each(?))
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`,
  )
  const insertPhase = deps.db.prepare(
    `INSERT INTO phase
       (id, project_id, name, position, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const nextPhasePositionStmt = deps.db.prepare(
    'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM phase WHERE project_id = ?',
  )
  const listPhasesStmt = deps.db.prepare(
    'SELECT * FROM phase WHERE project_id = ? ORDER BY position ASC, rowid ASC',
  )
  const getPhaseStmt = deps.db.prepare('SELECT * FROM phase WHERE id = ?')
  const insertTask = deps.db.prepare(
    `INSERT INTO task
       (id, project_id, phase_id, parent_task_id, title, description,
        assignee_profile, position, start_date, due_date, estimated_minutes,
        priority, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const nextTaskPositionStmt = deps.db.prepare(
    `SELECT COALESCE(MAX(position) + 1, 0) AS next FROM task
     WHERE phase_id = ?
       AND ((? IS NULL AND parent_task_id IS NULL)
         OR parent_task_id = ?)`,
  )
  const listTasksStmt = deps.db.prepare(
    'SELECT * FROM task WHERE project_id = ? ORDER BY rowid ASC',
  )
  const updateProjectStatusStmt = deps.db.prepare(
    `UPDATE project SET status = ?, updated_at = ?,
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
     WHERE id = ?`,
  )
  const updatePhaseStatusStmt = deps.db.prepare(
    `UPDATE phase SET status = ?, updated_at = ?,
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
     WHERE id = ?`,
  )
  const updateTaskStatusStmt = deps.db.prepare(
    `UPDATE task SET status = ?, updated_at = ?,
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
     WHERE id = ?`,
  )
  const getTaskProjectIdStmt = deps.db.prepare(
    'SELECT project_id FROM task WHERE id = ?',
  )
  const getPhaseProjectIdStmt = deps.db.prepare(
    'SELECT project_id FROM phase WHERE id = ?',
  )
  const insertDependencyStmt = deps.db.prepare(
    'INSERT INTO task_dependency (task_id, depends_on_task_id) VALUES (?, ?)',
  )
  const deleteDependencyStmt = deps.db.prepare(
    'DELETE FROM task_dependency WHERE task_id = ? AND depends_on_task_id = ?',
  )
  const listDependenciesStmt = deps.db.prepare(
    `SELECT t.* FROM task t
     JOIN task_dependency d ON d.depends_on_task_id = t.id
     WHERE d.task_id = ?
     ORDER BY t.rowid ASC`,
  )
  // Walk dependsOn edges starting from `from`; if we ever reach `target`, a cycle
  // would be created by inserting (target → from).
  const reachableStmt = deps.db.prepare(
    `WITH RECURSIVE reach(id) AS (
       SELECT depends_on_task_id FROM task_dependency WHERE task_id = ?
       UNION
       SELECT d.depends_on_task_id FROM task_dependency d JOIN reach r ON r.id = d.task_id
     )
     SELECT 1 AS hit FROM reach WHERE id = ? LIMIT 1`,
  )
  const getTaskStmt = deps.db.prepare('SELECT * FROM task WHERE id = ?')
  const updateTaskFieldsStmt = deps.db.prepare(
    `UPDATE task SET
       title = COALESCE(?, title),
       description = CASE WHEN ? THEN ? ELSE description END,
       assignee_profile = CASE WHEN ? THEN ? ELSE assignee_profile END,
       parent_task_id = CASE WHEN ? THEN ? ELSE parent_task_id END,
       start_date = CASE WHEN ? THEN ? ELSE start_date END,
       due_date = CASE WHEN ? THEN ? ELSE due_date END,
       estimated_minutes = CASE WHEN ? THEN ? ELSE estimated_minutes END,
       spent_minutes = CASE WHEN ? THEN ? ELSE spent_minutes END,
       priority = COALESCE(?, priority),
       updated_at = ?
     WHERE id = ?`,
  )
  const updateProjectFieldsStmt = deps.db.prepare(
    `UPDATE project SET
       name = COALESCE(?, name),
       client = CASE WHEN ? THEN ? ELSE client END,
       description = CASE WHEN ? THEN ? ELSE description END,
       updated_at = ?
     WHERE id = ?`,
  )
  const insertTaskFileStmt = deps.db.prepare(
    `INSERT INTO task_file (task_id, file_path, label, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, file_path) DO UPDATE SET label = excluded.label`,
  )
  const deleteTaskFileStmt = deps.db.prepare(
    'DELETE FROM task_file WHERE task_id = ? AND file_path = ?',
  )
  const listTaskFilesStmt = deps.db.prepare(
    'SELECT * FROM task_file WHERE task_id = ? ORDER BY created_at ASC, file_path ASC',
  )
  const updatePhaseFieldsStmt = deps.db.prepare(
    `UPDATE phase SET
       name = COALESCE(?, name),
       position = COALESCE(?, position),
       updated_at = ?
     WHERE id = ?`,
  )
  const listProjectDepsStmt = deps.db.prepare(
    `SELECT d.task_id, d.depends_on_task_id
       FROM task_dependency d
       JOIN task t ON t.id = d.task_id
      WHERE t.project_id = ?`,
  )
  const projectNumberPrefixStmt = deps.db.prepare(
    `SELECT number FROM project
      WHERE number LIKE ? || '%'
      ORDER BY number DESC`,
  )

  const service: ProjectsService = {
    createProject(input, ctx) {
      const id = randomUUID()
      const now = Date.now()
      const metadata = input.metadata ?? {}
      const folderPath =
        input.folderPath ?? `projects/${input.number} - ${sanitizeSlug(input.name)}`
      try {
        insertProject.run(
          id,
          input.number,
          input.name,
          input.client ?? null,
          input.description ?? null,
          folderPath,
          JSON.stringify(metadata),
          now,
          now,
        )
      } catch (err) {
        // SqliteError on UNIQUE(number) — surface as a domain error so
        // HTTP callers can map it to 409 without parsing SQLite strings.
        if (isUniqueViolation(err, 'project.number')) {
          throw new DuplicateProjectNumberError(input.number)
        }
        throw err
      }
      const project: Project = {
        id,
        number: input.number,
        name: input.name,
        client: input.client ?? null,
        description: input.description ?? null,
        status: 'pending',
        folderPath,
        metadata,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      }

      if (deps.storage) {
        const storage = deps.storage
        // Best-effort eager folder creation. Errors don't roll back the row —
        // the project record is authoritative; folder absence shows up later
        // as a UI signal (or the operator manually creates it).
        void (async () => {
          try {
            await storage.ensureDir(folderPath)
            await storage.ensureDir(`${folderPath}/in`)
            await storage.ensureDir(`${folderPath}/drafts`)
          } catch {
            // Swallow — see comment above.
          }
        })()
      }

      deps.audit.record({
        module: 'projects',
        action: 'project.created',
        entityType: 'project',
        entityId: id,
        actor: ctx.actor,
        payload: { number: input.number, name: input.name },
        projectId: id,
      })

      void deps.eventBus.emit({
        type: 'project.created',
        projectId: id,
        number: input.number,
        ts: now,
      })

      return project
    },

    getProject(id) {
      const row = getProjectStmt.get(id) as ProjectRow | undefined
      return row ? rowToProject(row) : undefined
    },

    listProjects(opts) {
      const limit = opts?.limit ?? 100
      const rows = (
        opts?.status && opts.status.length > 0
          ? listByStatusStmt.all(JSON.stringify(opts.status), limit)
          : listAllStmt.all(limit)
      ) as ProjectRow[]
      return rows.map(rowToProject)
    },

    addPhase(input, ctx) {
      const id = randomUUID()
      const now = Date.now()
      const metadata = input.metadata ?? {}
      const nextRow = nextPhasePositionStmt.get(input.projectId) as { next: number } | undefined
      const position = nextRow?.next ?? 0
      // FK on phase.project_id will throw if the project doesn't exist.
      insertPhase.run(
        id,
        input.projectId,
        input.name,
        position,
        JSON.stringify(metadata),
        now,
        now,
      )

      deps.audit.record({
        module: 'projects',
        action: 'phase.created',
        entityType: 'phase',
        entityId: id,
        actor: ctx.actor,
        payload: { projectId: input.projectId, name: input.name, position },
        projectId: input.projectId,
      })

      void deps.eventBus.emit({
        type: 'phase.created',
        projectId: input.projectId,
        phaseId: id,
        ts: now,
      })

      return {
        id,
        projectId: input.projectId,
        name: input.name,
        position,
        status: 'pending',
        metadata,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      }
    },

    listPhases(projectId) {
      const rows = listPhasesStmt.all(projectId) as PhaseRow[]
      return rows.map(rowToPhase)
    },

    addTask(input, ctx) {
      const phaseRow = getPhaseStmt.get(input.phaseId) as PhaseRow | undefined
      if (!phaseRow) {
        throw new NotFoundError('phase', input.phaseId)
      }
      if (phaseRow.project_id !== input.projectId) {
        throw new Error(
          `Phase ${input.phaseId} belongs to project ${phaseRow.project_id}, not ${input.projectId}`,
        )
      }

      const id = randomUUID()
      const now = Date.now()
      const metadata = input.metadata ?? {}
      const parentTaskId = input.parentTaskId ?? null
      const priority: TaskPriority = input.priority ?? 'normal'
      const nextRow = nextTaskPositionStmt.get(
        input.phaseId,
        parentTaskId,
        parentTaskId,
      ) as { next: number } | undefined
      const position = nextRow?.next ?? 0

      insertTask.run(
        id,
        input.projectId,
        input.phaseId,
        parentTaskId,
        input.title,
        input.description ?? null,
        input.assigneeProfile ?? null,
        position,
        input.startDate ?? null,
        input.dueDate ?? null,
        input.estimatedMinutes ?? null,
        priority,
        JSON.stringify(metadata),
        now,
        now,
      )

      deps.audit.record({
        module: 'projects',
        action: 'task.created',
        entityType: 'task',
        entityId: id,
        actor: ctx.actor,
        payload: {
          projectId: input.projectId,
          phaseId: input.phaseId,
          title: input.title,
          parentTaskId,
        },
        projectId: input.projectId,
      })

      void deps.eventBus.emit({
        type: 'task.created',
        projectId: input.projectId,
        phaseId: input.phaseId,
        taskId: id,
        ts: now,
      })

      return {
        id,
        projectId: input.projectId,
        phaseId: input.phaseId,
        parentTaskId,
        title: input.title,
        description: input.description ?? null,
        status: 'pending',
        assigneeProfile: input.assigneeProfile ?? null,
        position,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        estimatedMinutes: input.estimatedMinutes ?? null,
        spentMinutes: 0,
        priority,
        metadata,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      }
    },

    listTasks(projectId) {
      const rows = listTasksStmt.all(projectId) as TaskRow[]
      return rows.map(rowToTask)
    },

    setProjectStatus(id, status, ctx) {
      const now = Date.now()
      const info = updateProjectStatusStmt.run(status, now, status, now, id)
      if (info.changes === 0) {
        throw new NotFoundError('project', id)
      }
      deps.audit.record({
        module: 'projects',
        action: status === 'completed' ? 'project.completed' : 'project.updated',
        entityType: 'project',
        entityId: id,
        actor: ctx.actor,
        payload: { status },
        projectId: id,
      })
      void deps.eventBus.emit(
        status === 'completed'
          ? { type: 'project.completed', projectId: id, ts: now }
          : { type: 'project.updated', projectId: id, ts: now },
      )
    },

    setPhaseStatus(id, status, ctx) {
      const phaseRow = getPhaseProjectIdStmt.get(id) as { project_id: string } | undefined
      if (!phaseRow) {
        throw new NotFoundError('phase', id)
      }
      const now = Date.now()
      updatePhaseStatusStmt.run(status, now, status, now, id)
      deps.audit.record({
        module: 'projects',
        action: status === 'completed' ? 'phase.completed' : 'phase.updated',
        entityType: 'phase',
        entityId: id,
        actor: ctx.actor,
        payload: { status, projectId: phaseRow.project_id },
        projectId: phaseRow.project_id,
      })
      if (status === 'completed') {
        void deps.eventBus.emit({
          type: 'phase.completed',
          projectId: phaseRow.project_id,
          phaseId: id,
          ts: now,
        })
      }
    },

    setDependency(input, ctx) {
      if (input.taskId === input.dependsOnTaskId) {
        // The DB CHECK would catch this too; surface the same intent earlier
        // so the SqliteError message doesn't leak through.
        throw new Error('A task cannot depend on itself')
      }
      // Walking from dependsOnTaskId — if we can reach input.taskId by
      // following existing dependsOn edges, adding the new edge creates a cycle.
      const hit = reachableStmt.get(input.dependsOnTaskId, input.taskId) as
        | { hit: number }
        | undefined
      if (hit) {
        throw new TaskDependencyCycleError(input.taskId, input.dependsOnTaskId)
      }
      insertDependencyStmt.run(input.taskId, input.dependsOnTaskId)
      const projectIdRow = getTaskProjectIdStmt.get(input.taskId) as
        | { project_id: string }
        | undefined
      deps.audit.record({
        module: 'projects',
        action: 'task.dependency_added',
        entityType: 'task',
        entityId: input.taskId,
        actor: ctx.actor,
        payload: { dependsOnTaskId: input.dependsOnTaskId },
        projectId: projectIdRow?.project_id ?? null,
      })
    },

    removeDependency(input, ctx) {
      const projectIdRow = getTaskProjectIdStmt.get(input.taskId) as
        | { project_id: string }
        | undefined
      const info = deleteDependencyStmt.run(input.taskId, input.dependsOnTaskId)
      if (info.changes === 0) return
      deps.audit.record({
        module: 'projects',
        action: 'task.dependency_removed',
        entityType: 'task',
        entityId: input.taskId,
        actor: ctx.actor,
        payload: { dependsOnTaskId: input.dependsOnTaskId },
        projectId: projectIdRow?.project_id ?? null,
      })
    },

    getBlockers(taskId) {
      const rows = listDependenciesStmt.all(taskId) as TaskRow[]
      return rows.map(rowToTask)
    },

    setTaskStatus(id, status, ctx) {
      const row = getTaskProjectIdStmt.get(id) as { project_id: string } | undefined
      if (!row) {
        throw new NotFoundError('task', id)
      }
      const now = Date.now()
      updateTaskStatusStmt.run(status, now, status, now, id)
      const reason = ctx.reason ?? null
      deps.audit.record({
        module: 'projects',
        action:
          status === 'completed'
            ? 'task.completed'
            : status === 'blocked'
              ? 'task.blocked'
              : 'task.updated',
        entityType: 'task',
        entityId: id,
        actor: ctx.actor,
        payload: { status, projectId: row.project_id, reason },
        projectId: row.project_id,
      })
      if (status === 'completed') {
        void deps.eventBus.emit({
          type: 'task.completed',
          projectId: row.project_id,
          taskId: id,
          ts: now,
        })
      } else if (status === 'blocked') {
        void deps.eventBus.emit({
          type: 'task.blocked',
          projectId: row.project_id,
          taskId: id,
          reason,
          ts: now,
        })
      } else {
        void deps.eventBus.emit({
          type: 'task.updated',
          projectId: row.project_id,
          taskId: id,
          ts: now,
        })
      }
    },

    getTask(taskId) {
      const row = getTaskStmt.get(taskId) as TaskRow | undefined
      return row ? rowToTask(row) : undefined
    },

    getPhase(phaseId) {
      const row = getPhaseStmt.get(phaseId) as PhaseRow | undefined
      return row ? rowToPhase(row) : undefined
    },

    updateTask(input, ctx) {
      const existing = getTaskStmt.get(input.taskId) as TaskRow | undefined
      if (!existing) {
        throw new NotFoundError('task', input.taskId)
      }
      const now = Date.now()
      const descTouched = 'description' in input
      const assigneeTouched = 'assigneeProfile' in input
      const parentTouched = 'parentTaskId' in input
      const startTouched = 'startDate' in input
      const dueTouched = 'dueDate' in input
      const estimatedTouched = 'estimatedMinutes' in input
      const spentTouched = 'spentMinutes' in input

      updateTaskFieldsStmt.run(
        input.title ?? null,
        descTouched ? 1 : 0,
        descTouched ? input.description ?? null : null,
        assigneeTouched ? 1 : 0,
        assigneeTouched ? input.assigneeProfile ?? null : null,
        parentTouched ? 1 : 0,
        parentTouched ? input.parentTaskId ?? null : null,
        startTouched ? 1 : 0,
        startTouched ? input.startDate ?? null : null,
        dueTouched ? 1 : 0,
        dueTouched ? input.dueDate ?? null : null,
        estimatedTouched ? 1 : 0,
        estimatedTouched ? input.estimatedMinutes ?? null : null,
        spentTouched ? 1 : 0,
        spentTouched ? input.spentMinutes ?? 0 : null,
        input.priority ?? null,
        now,
        input.taskId,
      )

      const changedFields: string[] = []
      if (input.title !== undefined) changedFields.push('title')
      if (descTouched) changedFields.push('description')
      if (assigneeTouched) changedFields.push('assigneeProfile')
      if (parentTouched) changedFields.push('parentTaskId')
      if (startTouched) changedFields.push('startDate')
      if (dueTouched) changedFields.push('dueDate')
      if (estimatedTouched) changedFields.push('estimatedMinutes')
      if (spentTouched) changedFields.push('spentMinutes')
      if (input.priority !== undefined) changedFields.push('priority')

      if (changedFields.length > 0) {
        deps.audit.record({
          module: 'projects',
          action: 'task.updated',
          entityType: 'task',
          entityId: input.taskId,
          actor: ctx.actor,
          payload: { projectId: existing.project_id, fields: changedFields },
          projectId: existing.project_id,
        })
        void deps.eventBus.emit({
          type: 'task.updated',
          projectId: existing.project_id,
          taskId: input.taskId,
          ts: now,
        })
      }
      if (input.status !== undefined && input.status !== parseStatus(existing.status)) {
        const statusCtx: BlockedActorContext = { actor: ctx.actor }
        if (ctx.reason !== undefined) statusCtx.reason = ctx.reason
        service.setTaskStatus(input.taskId, input.status, statusCtx)
      }

      const after = getTaskStmt.get(input.taskId) as TaskRow
      return rowToTask(after)
    },

    updateProject(input, ctx) {
      const existing = getProjectStmt.get(input.projectId) as ProjectRow | undefined
      if (!existing) {
        throw new NotFoundError('project', input.projectId)
      }
      const now = Date.now()
      const clientTouched = 'client' in input
      const descTouched = 'description' in input

      updateProjectFieldsStmt.run(
        input.name ?? null,
        clientTouched ? 1 : 0,
        clientTouched ? input.client ?? null : null,
        descTouched ? 1 : 0,
        descTouched ? input.description ?? null : null,
        now,
        input.projectId,
      )

      const changedFields: string[] = []
      if (input.name !== undefined) changedFields.push('name')
      if (clientTouched) changedFields.push('client')
      if (descTouched) changedFields.push('description')

      if (changedFields.length > 0) {
        deps.audit.record({
          module: 'projects',
          action: 'project.updated',
          entityType: 'project',
          entityId: input.projectId,
          actor: ctx.actor,
          payload: { fields: changedFields },
          projectId: input.projectId,
        })
        void deps.eventBus.emit({
          type: 'project.updated',
          projectId: input.projectId,
          ts: now,
        })
      }

      const after = getProjectStmt.get(input.projectId) as ProjectRow
      return rowToProject(after)
    },

    attachTaskFile(input, ctx) {
      const existing = getTaskStmt.get(input.taskId) as TaskRow | undefined
      if (!existing) {
        throw new NotFoundError('task', input.taskId)
      }
      const now = Date.now()
      const label = input.label ?? null
      insertTaskFileStmt.run(input.taskId, input.filePath, label, now)
      deps.audit.record({
        module: 'projects',
        action: 'task.file_attached',
        entityType: 'task',
        entityId: input.taskId,
        actor: ctx.actor,
        payload: { projectId: existing.project_id, filePath: input.filePath, label },
        projectId: existing.project_id,
      })
      void deps.eventBus.emit({
        type: 'task.file_attached',
        projectId: existing.project_id,
        taskId: input.taskId,
        filePath: input.filePath,
        ts: now,
      })
      return { taskId: input.taskId, filePath: input.filePath, label, createdAt: now }
    },

    detachTaskFile(input, ctx) {
      const existing = getTaskStmt.get(input.taskId) as TaskRow | undefined
      if (!existing) {
        throw new NotFoundError('task', input.taskId)
      }
      const info = deleteTaskFileStmt.run(input.taskId, input.filePath)
      if (info.changes === 0) return
      const now = Date.now()
      deps.audit.record({
        module: 'projects',
        action: 'task.file_detached',
        entityType: 'task',
        entityId: input.taskId,
        actor: ctx.actor,
        payload: { projectId: existing.project_id, filePath: input.filePath },
        projectId: existing.project_id,
      })
      void deps.eventBus.emit({
        type: 'task.file_detached',
        projectId: existing.project_id,
        taskId: input.taskId,
        filePath: input.filePath,
        ts: now,
      })
    },

    listTaskFiles(taskId) {
      const rows = listTaskFilesStmt.all(taskId) as TaskFileRow[]
      return rows.map(rowToTaskFile)
    },

    updatePhase(input, ctx) {
      const existing = getPhaseStmt.get(input.phaseId) as PhaseRow | undefined
      if (!existing) {
        throw new Error(`Phase not found: ${input.phaseId}`)
      }
      const now = Date.now()

      updatePhaseFieldsStmt.run(
        input.name ?? null,
        input.position !== undefined ? input.position : null,
        now,
        input.phaseId,
      )

      const changed: string[] = []
      if (input.name !== undefined) changed.push('name')
      if (input.position !== undefined) changed.push('position')

      if (changed.length > 0) {
        deps.audit.record({
          module: 'projects',
          action: 'phase.updated',
          entityType: 'phase',
          entityId: input.phaseId,
          actor: ctx.actor,
          payload: { projectId: existing.project_id, fields: changed },
          projectId: existing.project_id,
        })
      }
      if (input.status !== undefined && input.status !== parseStatus(existing.status)) {
        service.setPhaseStatus(input.phaseId, input.status, ctx)
      }

      const after = getPhaseStmt.get(input.phaseId) as PhaseRow
      return rowToPhase(after)
    },

    listAllDependencies(projectId) {
      const rows = listProjectDepsStmt.all(projectId) as Array<{
        task_id: string
        depends_on_task_id: string
      }>
      return rows.map((r) => ({
        taskId: r.task_id,
        dependsOnTaskId: r.depends_on_task_id,
      }))
    },

    suggestNextNumber(year) {
      const yy = (year ?? new Date().getFullYear()) % 100
      const prefix = String(yy).padStart(2, '0')
      const rows = projectNumberPrefixStmt.all(prefix) as Array<{ number: string }>
      let maxIdx = 0
      for (const r of rows) {
        const m = /^(\d{2})(\d{3})$/.exec(r.number)
        if (!m) continue
        const n = Number(m[2])
        if (n > maxIdx) maxIdx = n
      }
      const next = String(maxIdx + 1).padStart(3, '0')
      return `${prefix}${next}`
    },

    getProjectBudget(projectId) {
      // Phase 5 wires the project_budget view properly; Phase 2 only needs to
      // not crash when no invoices exist. We probe for the view and fall back
      // to zeros if it isn't present yet.
      try {
        const row = deps.db
          .prepare(
            `SELECT project_id AS projectId,
                    budget_cents AS budgetCents,
                    invoiced_cents AS invoicedCents,
                    paid_cents AS paidCents,
                    draft_cents AS draftCents
               FROM project_budget WHERE project_id = ?`,
          )
          .get(projectId) as ProjectBudget | undefined
        if (row) return row
      } catch {
        // view doesn't exist yet
      }
      const project = service.getProject(projectId)
      const budgetCents =
        (project?.metadata as { budgetCents?: number } | undefined)?.budgetCents ?? null
      return {
        projectId,
        budgetCents,
        invoicedCents: 0,
        paidCents: 0,
        draftCents: 0,
      }
    },
  }
  return service
}

import { randomUUID } from 'node:crypto'
import type { Db } from '../../../src/storage/db.js'
import type { EventBus } from '../../../src/core/events.js'
import type { AuditActor, AuditLog } from '../../../src/modules/audit-log.js'
import type { StorageAdapter } from '../../../src/storage/adapter.js'

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

export interface ProjectsService {
  createProject(input: CreateProjectInput, ctx: ActorContext): Project
  getProject(id: string): Project | undefined
  listProjects(opts?: ListProjectsOptions): Project[]
  addPhase(input: AddPhaseInput, ctx: ActorContext): Phase
  listPhases(projectId: string): Phase[]
  addTask(input: AddTaskInput, ctx: ActorContext): Task
  listTasks(projectId: string): Task[]
  setProjectStatus(id: string, status: EntityStatus, ctx: ActorContext): void
  setPhaseStatus(id: string, status: EntityStatus, ctx: ActorContext): void
  setTaskStatus(id: string, status: EntityStatus, ctx: BlockedActorContext): void
  setDependency(input: TaskDependencyInput, ctx: ActorContext): void
  removeDependency(input: TaskDependencyInput, ctx: ActorContext): void
  getBlockers(taskId: string): Task[]
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
  metadata_json: string
  created_at: number
  updated_at: number
  completed_at: number | null
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
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
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
        assignee_profile, position, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  return {
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
        throw new Error(`Phase not found: ${input.phaseId}`)
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
        throw new Error(`Project not found: ${id}`)
      }
      deps.audit.record({
        module: 'projects',
        action: status === 'completed' ? 'project.completed' : 'project.updated',
        entityType: 'project',
        entityId: id,
        actor: ctx.actor,
        payload: { status },
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
        throw new Error(`Phase not found: ${id}`)
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
      deps.audit.record({
        module: 'projects',
        action: 'task.dependency_added',
        entityType: 'task',
        entityId: input.taskId,
        actor: ctx.actor,
        payload: { dependsOnTaskId: input.dependsOnTaskId },
      })
    },

    removeDependency(input, ctx) {
      const info = deleteDependencyStmt.run(input.taskId, input.dependsOnTaskId)
      if (info.changes === 0) return
      deps.audit.record({
        module: 'projects',
        action: 'task.dependency_removed',
        entityType: 'task',
        entityId: input.taskId,
        actor: ctx.actor,
        payload: { dependsOnTaskId: input.dependsOnTaskId },
      })
    },

    getBlockers(taskId) {
      const rows = listDependenciesStmt.all(taskId) as TaskRow[]
      return rows.map(rowToTask)
    },

    setTaskStatus(id, status, ctx) {
      const row = getTaskProjectIdStmt.get(id) as { project_id: string } | undefined
      if (!row) {
        throw new Error(`Task not found: ${id}`)
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
  }
}

import type {
  Session,
  Turn,
  ToolCallRecord,
  Notification,
  ProfileListEntry,
  DraftEntry,
  CommandDescriptor,
  ModuleAction,
  ModuleActionsError,
  Project,
  Phase,
  Task,
  TaskDependency,
  EntityStatus,
  ProjectBudget,
  ActivityEntry,
  ProjectFilesEntry,
} from './domain'

export interface ListSessionsResponse {
  sessions: Session[]
}

export interface CreateSessionRequest {
  agentProfile?: string
  title?: string | null
  seed?: { spawnedBy: string; initialMessage: string }
}
export interface CreateSessionResponse {
  session: Session
}

export interface SessionDetailResponse {
  session: Session
  turns: Turn[]
  toolCalls: Record<string, ToolCallRecord[]>
}

export interface SendMessageRequest {
  text: string
}
export interface SendMessageResponse {
  ok: true
}

export interface CancelTurnResponse {
  outcome: 'cancelled' | 'no_active_turn' | 'unknown_session'
}

export interface RenameSessionRequest {
  title: string
}
export interface RenameSessionResponse {
  session: Session
}

export interface ListProfilesResponse {
  profiles: ProfileListEntry[]
  current: string
}

export interface CreateProfileRequest {
  id: string
  description?: string | null
  extends?: string | null
  default_model?: string
  default_skills?: string[]
  permissions?: unknown
  deny_tools?: string[]
  passive_recall?: { enabled: boolean }
  auto_distill?: { enabled: boolean }
}
export type CreateProfileResponse = ProfileListEntry
export type UpdateProfileRequest = Omit<Partial<CreateProfileRequest>, 'id'>
export type UpdateProfileResponse = ProfileListEntry
export type DeleteProfileResponse = { ok: true }

export interface ListDraftsResponse {
  drafts: DraftEntry[]
}

export interface ListCommandsResponse {
  commands: CommandDescriptor[]
}

export interface RunCommandRequest {
  name: string
  args?: Record<string, unknown>
  text?: string
}
export interface RunCommandResponse {
  result: unknown
}

export interface ListNotificationsResponse {
  notifications: Notification[]
}

export interface UpdateNotificationRequest {
  status: 'read' | 'resolved' | 'dismissed'
}
export interface UpdateNotificationResponse {
  notification: Notification
}

export interface AnswerNotificationRequest {
  value: string
}
export interface AnswerNotificationResponse {
  ok: true
}

export interface ListModuleActionsResponse {
  actions: ModuleAction[]
  errors: ModuleActionsError[]
}

export interface DispatchModuleActionRequest {
  action: string
  contextId: string
  args?: Record<string, unknown>
}
export interface DispatchModuleActionResponse {
  sessionId: string
  action: string
}

export interface ApiErrorBody {
  error: string
  message?: string
  details?: unknown
}

// ── Projects ───────────────────────────────────────────────────────────────

export interface ListProjectsResponse {
  projects: Project[]
}

export interface CreateProjectRequest {
  number: string
  name: string
  client?: string
  description?: string
  folderPath?: string
  metadata?: Record<string, unknown>
}
export interface CreateProjectResponse {
  project: Project
}

export interface ProjectDetailResponse {
  project: Project
  phases: Phase[]
  tasks: Task[]
  dependencies: TaskDependency[]
}

export interface UpdateProjectStatusRequest {
  status: EntityStatus
}
export interface UpdateProjectStatusResponse {
  project: Project
}

export interface AddPhaseRequest {
  name: string
  metadata?: Record<string, unknown>
}
export interface AddPhaseResponse {
  phase: Phase
}

export interface UpdatePhaseRequest {
  name?: string
  status?: EntityStatus
  position?: number
}
export interface UpdatePhaseResponse {
  phase: Phase
}

export interface AddTaskRequest {
  phaseId: string
  title: string
  description?: string
  parentTaskId?: string
  assigneeProfile?: string
  metadata?: Record<string, unknown>
}
export interface AddTaskResponse {
  task: Task
}

export interface UpdateTaskRequest {
  title?: string
  description?: string | null
  status?: EntityStatus
  assigneeProfile?: string | null
  parentTaskId?: string | null
  reason?: string | null
}
export interface UpdateTaskResponse {
  task: Task
}

export interface AddDependencyRequest {
  dependsOnTaskId: string
}
export interface AddDependencyResponse {
  dependency: TaskDependency
}

export interface ProjectActivityResponse {
  entries: ActivityEntry[]
  hasMore: boolean
}

export interface ProjectScopeResponse {
  path: string | null
  markdown: string | null
  generatedAt: string | null
}

export interface ProjectFilesResponse {
  rootPath: string
  entries: ProjectFilesEntry[]
}

export type ProjectBudgetResponse = ProjectBudget

export interface NextProjectNumberResponse {
  number: string
}

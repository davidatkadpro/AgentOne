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

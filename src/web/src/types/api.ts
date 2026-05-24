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
  ActivityEntry,
  ProjectFilesEntry,
  Email,
  EmailBody,
  EmailPollResult,
  ArtifactRow,
  ArtifactHistoryEntry,
  Estimate,
  EstimateKind,
  EstimateStatus,
  Proposal,
  ProposalRenderedFile,
  ProposalScopeFile,
  ProposalStatus,
  ProposalTemplate,
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

// ProjectBudgetResponse is declared further down with the canonical shape
// returned by /api/projects/:id/budget (`{ budget: InvoiceBudget }`).

export interface NextProjectNumberResponse {
  number: string
}

// ── Email ──────────────────────────────────────────────────────────────────

export interface ListEmailsQuery {
  isRead?: boolean
  filed?: boolean
  hasAttachments?: boolean
  projectId?: string
  limit?: number
}
export interface ListEmailsResponse {
  emails: Email[]
}

export interface EmailDetailResponse {
  email: Email
}

export type EmailBodyResponse = EmailBody

export interface UpdateEmailRequest {
  isRead: boolean
}
export interface UpdateEmailResponse {
  email: Email
}

export type PollEmailResponse = EmailPollResult

export interface DispatchEmailActionRequest {
  action: string
  contextId: string
  args?: Record<string, unknown>
}
export interface DispatchEmailActionResponse {
  sessionId: string
  action: string
}

// ── Proposals ──────────────────────────────────────────────────────────────

export interface ListArtifactsQuery {
  projectId?: string
  status?: string | string[]
  search?: string
  limit?: number
}
export interface ListArtifactsResponse {
  artifacts: ArtifactRow[]
}

export interface ProposalDetailResponse {
  estimate: Estimate
  proposal: Proposal | null
  predecessorEstimates: Estimate[]
}

export interface CreateEstimateLineInput {
  kind?: EstimateKind
  description: string
  qty?: number
  unit?: string | null
  unitPrice?: number
  metadata?: Record<string, unknown>
}

export interface CreateEstimateRequest {
  scopeFilePath?: string | null
  sourceScopePath?: string | null
  templateName?: string
  notes?: string
  lines?: CreateEstimateLineInput[]
  metadata?: Record<string, unknown>
}
export interface CreateEstimateResponse {
  estimate: Estimate
}

export interface UpdateEstimateLineInput extends CreateEstimateLineInput {
  id?: string
}

export interface UpdateEstimateRequest {
  status?: EstimateStatus
  templateName?: string
  notes?: string | null
  sourceScopePath?: string | null
  scopeFilePath?: string | null
  metadata?: Record<string, unknown>
  lines?: UpdateEstimateLineInput[]
}
export interface UpdateEstimateResponse {
  estimate: Estimate
}

export interface ReviseEstimateResponse {
  estimate: Estimate
}

export interface CreateProposalRequest {
  estimateId: string
  templateName?: string
  metadata?: Record<string, unknown>
}
export interface CreateProposalResponse {
  proposal: Proposal
}

export interface UpdateProposalRequest {
  status?: ProposalStatus
  supersededByProposalId?: string | null
}
export interface UpdateProposalResponse {
  proposal: Proposal
}

export interface RenderProposalRequest {
  formats: Array<'md' | 'pdf' | 'docx'>
}
export interface RenderProposalResponse {
  files: ProposalRenderedFile[]
  unavailable: Array<'pdf' | 'docx'>
}

export interface ListTemplatesResponse {
  templates: ProposalTemplate[]
}

export interface ListScopeFilesResponse {
  files: ProposalScopeFile[]
}

export interface ProposalHistoryResponse {
  entries: ArtifactHistoryEntry[]
}

// ── Invoicing (Phase 5) ─────────────────────────────────────────────────

export interface ListInvoicesQuery {
  projectId?: string
  status?: import('./domain.js').InvoiceStatus | import('./domain.js').InvoiceStatus[]
  syncStatus?: import('./domain.js').SyncStatus | import('./domain.js').SyncStatus[]
  limit?: number
}
export interface ListInvoicesResponse {
  invoices: import('./domain.js').Invoice[]
}

export interface InvoiceDetailResponse {
  invoice: import('./domain.js').Invoice
  payments: import('./domain.js').Payment[]
  drift: import('./domain.js').InvoiceDrift | null
}

export interface CreateInvoiceRequest {
  proposalId?: string
  taxAmount?: number
  dueDate?: number
  notes?: string
  lines: Array<{
    kind?: import('./domain.js').InvoiceLineKind
    description: string
    qty?: number
    unit?: string | null
    unitPrice?: number
    metadata?: Record<string, unknown>
  }>
}
export interface CreateInvoiceResponse {
  invoice: import('./domain.js').Invoice
}

export interface CreateInvoiceFromProposalRequest {
  proposalId: string
  taxAmount?: number
  dueDate?: number
  notes?: string
}
export type CreateInvoiceFromProposalResponse = CreateInvoiceResponse

export interface UpdateInvoiceRequest {
  status?: import('./domain.js').InvoiceStatus
  taxAmount?: number
  dueDate?: number | null
  notes?: string | null
  metadata?: Record<string, unknown>
  lines?: Array<{
    id?: string
    kind?: import('./domain.js').InvoiceLineKind
    description: string
    qty?: number
    unit?: string | null
    unitPrice?: number
    metadata?: Record<string, unknown>
  }>
}
export type UpdateInvoiceResponse = CreateInvoiceResponse

export interface RecordPaymentRequest {
  amount: number
  receivedAt?: number
  method?: import('./domain.js').PaymentMethod
  reference?: string
  notes?: string
}
export interface RecordPaymentResponse {
  payment: import('./domain.js').Payment
  invoice: import('./domain.js').Invoice
}

export interface PushInvoiceRequest {
  force?: boolean
}
export interface PushInvoiceResponse {
  qboId: string
  qboDocNumber: string | null
  syncStatus: 'synced'
  lastSyncedAt: string
  invoice: import('./domain.js').Invoice
}

export interface PullInvoiceResponse {
  syncStatus: 'synced' | 'drift'
  lastSyncedAt: string
  driftFields?: string[]
  invoice: import('./domain.js').Invoice
}

export interface ReconcileRequest {
  strategy: 'keep_local' | 'accept_qbo' | 'merge'
  merged?: Record<string, unknown>
}
export interface ReconcileResponse {
  syncStatus: 'synced'
  lastSyncedAt: string
  resolution: 'keep_local' | 'accept_qbo' | 'merge'
  invoice: import('./domain.js').Invoice
}

export type QboStatusResponse = import('./domain.js').QboConnection

export interface ProjectBudgetResponse {
  budget: import('./domain.js').InvoiceBudget
}

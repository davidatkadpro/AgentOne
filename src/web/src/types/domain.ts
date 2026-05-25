// Domain types mirroring the server. Keep in sync with src/core/types.ts and
// src/modules/notifications.ts on the server side.

export type Role = 'system' | 'user' | 'assistant' | 'tool'
export type SessionState = 'active' | 'awaiting_input' | 'archived'

export interface Session {
  id: string
  title: string | null
  agentProfile: string
  createdAt: number
  state: SessionState
  spawnedBy: string | null
}

export interface Turn {
  id: string
  sessionId: string
  role: Role
  content: string
  tokenCount: number
  createdAt: number
  compressedFrom?: string | null
  toolCallId?: string | null
}

export interface ToolCallRecord {
  id: string
  toolCallId: string
  turnId: string
  tool: string
  argsJson?: string
  resultJson?: string
  ok?: boolean
  durationMs?: number
  createdAt: number
}

export interface ToolChipState {
  toolCallId: string
  tool: string
  status: 'pending' | 'done' | 'failed'
  durationMs?: number
  failCode?: string
  failMessage?: string
  truncated?: boolean
  /** Captured from the `tool.called` event (live) or `argsJson` of the
   *  persisted record (hydrated). May be undefined for chips emitted before
   *  the args wiring landed. */
  args?: unknown
  /** Captured from the persisted `resultJson`. Live results aren't on the
   *  WS event; the chip stays argless until the next session reload. */
  result?: unknown
}

export interface ProfileListEntry {
  id: string
  description: string | null
  defaultModel: string
  defaultSkills: string[]
  ok: boolean
  error?: string
}

export interface NotificationOption {
  label: string
  value: string
}

export interface AttentionNeededPayload {
  question: string
  options?: NotificationOption[]
}

export type NotificationPayload = AttentionNeededPayload | Record<string, unknown>

export interface Notification {
  id: number
  kind: 'info' | 'attention_needed' | 'error'
  title: string
  body: string
  sessionId: string | null
  module: string | null
  payload: NotificationPayload
  status: 'unread' | 'read' | 'resolved' | 'dismissed'
  createdAt: number
  resolvedAt: number | null
}

export interface DraftEntry {
  path: string
  sessionId: string
  generatedAt: string
  title: string
  noteCount: number
  mtime: string
  bytes: number
}

export interface CommandDescriptor {
  name: string
  description: string
  usage: string
  requiresSession: boolean
  source: 'system' | 'skill'
  skill?: string
}

export interface HealthResponse {
  status: 'ok'
  model: string
  contextWindow: number
  storageRoot: string
  wikiPrefix: string
  agentProfile: string
  capabilities?: { pandoc: boolean }
  emailSource?: { kind: string; ok: boolean; configured: boolean }
}

export interface ModuleAction {
  name: string
  label: string
  description: string
  icon: string | null
  defaultProfile: string | null
  requiresConfirmation: boolean
  surface: 'action' | 'ask_agent' | 'both'
  tabs: string[]
}

export interface ModuleActionsError {
  skill: string
  error: string
}

export function isAttentionPayload(p: NotificationPayload | null | undefined): p is AttentionNeededPayload {
  return !!p && typeof (p as AttentionNeededPayload).question === 'string'
}

// ── Projects module domain ────────────────────────────────────────────────

export type EntityStatus = 'pending' | 'active' | 'blocked' | 'completed' | 'cancelled'

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

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

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

export interface TaskDependency {
  taskId: string
  dependsOnTaskId: string
}

export interface TaskFile {
  taskId: string
  filePath: string
  label: string | null
  createdAt: number
}

/** @deprecated — use {@link InvoiceBudget} instead. Kept as an alias so existing
 *  imports keep compiling while the BudgetChip is migrated. */
export interface ProjectBudget {
  projectId: string
  budgetTotal: number
  invoicedTotal: number
  paidTotal: number
}

export interface ActivityEntry {
  id: number
  ts: number
  actorKind: 'agent' | 'user' | 'scheduler' | 'hook' | 'module'
  actorId: string | null
  module: string
  action: string
  targetId: string | null
  details: Record<string, unknown>
}

export interface ProjectFilesEntry {
  relativePath: string
  name: string
  kind: 'file' | 'directory'
  bytes: number
  mtime: string
}

// ── Email module ──────────────────────────────────────────────────────────

export interface Email {
  id: string
  sourceKind: string
  sourceId: string
  receivedAt: number
  fromAddress: string
  fromName: string | null
  subject: string | null
  snippet: string | null
  hasAttachments: boolean
  isRead: boolean
  filedProjectId: string | null
  filedFolderPath: string | null
  filedAt: number | null
  metadata: Record<string, unknown>
  createdAt: number
}

export interface EmailAttachmentSummary {
  filename: string
  bytes: number
  contentType: string | null
}

export interface EmailBody {
  emailId: string
  kind: 'html' | 'text'
  content: string
  attachments: EmailAttachmentSummary[]
}

export interface EmailActionChip {
  emailId: string
  action: string
  sessionId: string
  status: 'running' | 'completed' | 'failed'
  result?: { projectId?: string; projectNumber?: string }
  startedAt: number
  endedAt?: number
}

export interface EmailPollResult {
  ingested: number
}

// ── Proposals module ──────────────────────────────────────────────────────

export type EstimateKind = 'fixed' | 'time_and_materials' | 'unit'
export type EstimateStatus = 'draft' | 'ready' | 'accepted' | 'rejected' | 'superseded'
export type ProposalStatus = 'draft' | 'issued' | 'accepted' | 'rejected' | 'superseded'

export interface EstimateLine {
  id: string
  estimateId: string
  kind: EstimateKind
  description: string
  qty: number
  unit: string | null
  unitPrice: number
  lineTotal: number
  position: number
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface Estimate {
  id: string
  projectId: string
  version: number
  sourceScopePath: string | null
  status: EstimateStatus
  notes: string | null
  previousEstimateId: string | null
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  decidedAt: number | null
  lines: EstimateLine[]
}

export interface Proposal {
  id: string
  projectId: string
  estimateId: string
  number: string
  status: ProposalStatus
  templateName: string
  renderedMarkdownPath: string | null
  previousProposalId: string | null
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  issuedAt: number | null
  decidedAt: number | null
}

export interface ArtifactRow {
  kind: 'estimate' | 'proposal'
  id: string
  number: string
  projectId: string
  projectNumber: string
  projectName: string
  status: EstimateStatus | ProposalStatus
  /** Combined "Estimate · draft", "Proposal · issued", etc. */
  displayStatus: string
  totalCents: number
  lastActivity: number
  source: 'from scope.md' | 'manual'
  scopeFilePath: string | null
}

export interface ProposalTemplate {
  name: string
  source: 'module' | 'override'
  path: string
  description: string | null
}

export interface ProposalScopeFile {
  path: string
  mtime: string
  bytes: number
}

export interface ArtifactHistoryEntry {
  ts: number
  actorKind: 'agent' | 'user' | 'scheduler' | 'hook' | 'module'
  module: string
  action: string
  fromStatus: string | null
  toStatus: string | null
  details: Record<string, unknown>
}

export interface ProposalRenderedFile {
  path: string
  kind: 'md' | 'pdf' | 'docx'
  mtime: string
  bytes: number
}

// ── Invoicing (Phase 5) ─────────────────────────────────────────────────

export type InvoiceStatus = 'draft' | 'issued' | 'partial' | 'paid' | 'void'
export type SyncStatus = 'local' | 'pending' | 'synced' | 'drift' | 'failed'
export type PaymentMethod = 'check' | 'ach' | 'card' | 'wire' | 'cash' | 'other'
export type InvoiceLineKind = 'fixed' | 'time_and_materials' | 'unit'

export interface InvoiceLine {
  id: string
  invoiceId: string
  kind: InvoiceLineKind
  description: string
  qty: number
  unit: string | null
  unitPrice: number
  lineTotal: number
  position: number
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface Payment {
  id: string
  invoiceId: string
  amount: number
  receivedAt: number
  method: PaymentMethod
  reference: string | null
  notes: string | null
  metadata: Record<string, unknown>
  createdAt: number
}

export interface Invoice {
  id: string
  projectId: string
  proposalId: string | null
  number: string
  status: InvoiceStatus
  subtotal: number
  taxAmount: number
  total: number
  amountPaid: number
  dueDate: number | null
  notes: string | null
  qboId: string | null
  qboDocNumber: string | null
  syncStatus: SyncStatus
  lastSyncedAt: number | null
  lastError: Record<string, unknown> | null
  previousInvoiceId: string | null
  qboPullSnapshot: Record<string, unknown> | null
  driftFields: string[]
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  issuedAt: number | null
  paidAt: number | null
  lines: InvoiceLine[]
}

export interface InvoiceDrift {
  invoiceId: string
  driftFields: string[]
  local: Record<string, unknown>
  qbo: Record<string, unknown>
}

export interface QboConnection {
  connected: boolean
  realmId?: string
  companyName?: string | null
  connectedAt?: number
  tokenExpiresAt?: number
  lastPushAt?: number | null
  lastPullAt?: number | null
  lastError?: { code: string; message: string; at: number } | null
}

export interface InvoiceBudget {
  projectId: string
  budgetTotal: number
  invoicedTotal: number
  paidTotal: number
}

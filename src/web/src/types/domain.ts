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

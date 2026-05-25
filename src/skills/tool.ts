import type { z } from 'zod'
import type { StorageAdapter } from '../storage/adapter.js'
import type { WikiEngine } from '../memory/wiki/engine.js'
import type { DocumentIndex } from '../memory/documents/doc-index.js'
import type { ConversationStore } from '../storage/sqlite.js'
import type { HybridRecall } from '../search/hybrid.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { ModelProfile } from '../core/types.js'
import type { EventBus } from '../core/events.js'
import type { PermissionGate } from '../profiles/permission-gate.js'
import type { ExpertSpendTracker } from './expert-spend.js'
import type { Notifications } from '../modules/notifications.js'
import type { ModuleRegistry } from '../modules/registry.js'

/**
 * Stable error codes the agent can reason about. Tools should always return
 * structured results — exceptions reserved for catastrophic runtime failures
 * the agent has no recourse for.
 */
export type ToolErrorCode =
  | 'TOOL_VALIDATION'
  | 'TOOL_RUNTIME'
  | 'TOOL_TIMEOUT'
  | 'PERMISSION_DENIED'
  | 'RESOURCE_UNAVAILABLE'
  | 'BUDGET_EXCEEDED'
  | 'RATE_LIMITED'
  | 'SKILL_LOAD_FAILED'

export interface ToolError {
  code: ToolErrorCode
  message: string
  recoverable: boolean
  details?: Record<string, unknown>
}

export type ToolResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: ToolError }

/**
 * Runtime services that skill handlers may use. Held on the ToolContext so
 * dynamically-imported handler modules don't need to reach into the rest of
 * the codebase — they get their dependencies through the function argument.
 */
export interface ToolServices {
  storage: StorageAdapter
  wiki: WikiEngine
  /** Lazy FTS5 index over project documents. Used by doc_search. Re-extracts
   *  on mtime change; nullable for tests that don't need it. */
  documents: DocumentIndex
  conversationStore: ConversationStore
  recall: HybridRecall
  /** Providers keyed by id ('lmstudio', 'openrouter'). Used by consult_expert. */
  providers: ProviderRegistry
  /** Model profiles keyed by their id. consult_expert looks up the expert
   *  model and its provider here. */
  modelProfiles: Map<string, ModelProfile>
  eventBus: EventBus
  /** User-facing notification tray. Per ADR-0005 the writer set is:
   *  the orchestrator (on `request_user_input`), Modules (on domain events
   *  worth surfacing), and Hooks (settings-driven). Today only the
   *  orchestrator path is realised — Module-driven notifications are a
   *  planned extension. The surface stays wide on ToolServices so adding
   *  Module writers later doesn't require reshaping the dep bag. */
  notifications: Notifications
  /** Per-module service handles. Skills should reach typed module services
   *  via `ctx.services.modules.getActiveService<ProjectsService>('projects')`
   *  — the helper returns undefined when the module is missing or degraded,
   *  replacing the (get → status check → unsafe cast) trio handlers used to
   *  open-code. `.get()` remains available for diagnostic introspection. */
  modules: ModuleRegistry
}

export interface ToolContext {
  sessionId: string
  agentProfile: string
  services: ToolServices
  /** Per-session permission gate; consult_expert and load_skill check this
   *  before invoking. Passed via ctx so the gate reflects the *current*
   *  session's agent profile rather than a process-wide default. */
  permissions: PermissionGate
  /** Per-session running USD spend on expert calls. */
  expertSpend: ExpertSpendTracker
  /**
   * Cancellation signal for this turn. Tool handlers that do meaningful
   * I/O should honour it (pass to fetch, abort long-running ops). Handlers
   * that don't are simply hard-aborted by the per-tool timeout — the
   * existing 10s default still bounds worst-case latency on cancel.
   */
  signal?: AbortSignal
}

export type ToolHandler<P extends z.ZodTypeAny = z.ZodTypeAny> = (
  args: z.infer<P>,
  ctx: ToolContext,
) => Promise<ToolResult> | ToolResult

export interface ToolModule<P extends z.ZodTypeAny = z.ZodTypeAny> {
  parameters: P
  handler: ToolHandler<P>
}

/** A registered tool ready for the orchestrator to surface to the model. */
export interface RegisteredTool {
  id: string
  description: string
  parameters: z.ZodTypeAny
  handler: ToolHandler
  /** Either "core" or the originating skill's name. */
  source: string
  timeoutMs?: number
}

export interface ModelToolCall {
  id: string
  name: string
  argumentsRaw: string
}

export function toolError(
  code: ToolErrorCode,
  message: string,
  recoverable: boolean,
  details?: Record<string, unknown>,
): ToolError {
  return details !== undefined
    ? { code, message, recoverable, details }
    : { code, message, recoverable }
}

export function ok<T>(value: T): ToolResult<T> {
  return { ok: true, value }
}

export function fail(
  code: ToolErrorCode,
  message: string,
  recoverable = false,
  details?: Record<string, unknown>,
): ToolResult {
  return { ok: false, error: toolError(code, message, recoverable, details) }
}

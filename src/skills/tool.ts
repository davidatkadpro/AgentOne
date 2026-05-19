import type { z } from 'zod'
import type { StorageAdapter } from '../storage/adapter.js'
import type { WikiEngine } from '../memory/wiki/engine.js'

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
}

export interface ToolContext {
  sessionId: string
  agentProfile: string
  services: ToolServices
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

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PostToolHook } from './hooks.js'

/**
 * Worked example hook: writes a JSON Lines audit record per tool call to
 * `<path>`. Captures the tool id, source skill, session, timestamp, success,
 * and an optionally redacted args summary. Intended as a reference for
 * operators who want a tamper-evident record outside the SQLite event_log.
 *
 * `redactArgs` (optional): given the validated args object, returns whatever
 * should be persisted in `argsSummary`. Defaults to a shallow `Object.keys`
 * dump so the audit log doesn't leak free-text user content by default.
 */
export interface AuditLogHookConfig {
  /** Absolute path to the JSONL file. Parent directories are created. */
  path: string
  redactArgs?: (args: unknown) => unknown
  /** Override Date.now for tests. */
  now?: () => number
}

export function buildAuditLogHook(cfg: AuditLogHookConfig): PostToolHook {
  const redact = cfg.redactArgs ?? defaultRedactor
  const now = cfg.now ?? Date.now
  let parentEnsured = false

  return {
    name: 'audit-log',
    async fn(result, ctx) {
      if (!parentEnsured) {
        await mkdir(dirname(cfg.path), { recursive: true })
        parentEnsured = true
      }
      const record = {
        ts: now(),
        sessionId: ctx.sessionId,
        agentProfile: ctx.agentProfile,
        tool: ctx.toolId,
        source: ctx.toolSource,
        argsSummary: redact(ctx.args),
        ok: result.ok,
        ...(result.ok
          ? {}
          : { errorCode: result.error.code, errorMessage: result.error.message }),
      }
      await appendFile(cfg.path, JSON.stringify(record) + '\n', 'utf-8')
      return { transform: 'pass' }
    },
  }
}

function defaultRedactor(args: unknown): unknown {
  if (!args || typeof args !== 'object') return null
  // Just expose the arg keys, not values — a conservative default that
  // doesn't leak the user's actual text content.
  return Object.keys(args as Record<string, unknown>)
}

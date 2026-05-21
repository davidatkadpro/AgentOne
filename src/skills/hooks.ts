import type { ToolResult } from './tool.js'

/**
 * Tool hooks are interposition points between schema validation and handler
 * invocation (pre) and between the handler return and persistence (post).
 * They give operators a way to add cross-cutting policy — redaction, audit,
 * deny rules, response rewrites — without modifying skills.
 *
 * Hooks run synchronously through the tool path. A pre-hook may allow with
 * (optionally mutated) args, deny the call outright, or mock a result and
 * skip the handler. A post-hook may pass the result through or replace it.
 *
 * Failure model is fail-closed: if a hook throws, the tool call fails with
 * `TOOL_RUNTIME`. A broken redaction or audit hook MUST NOT silently let
 * the call proceed — that's the whole reason it exists.
 */
export interface ToolHookContext {
  sessionId: string
  agentProfile: string
  toolId: string
  /** "core" or the originating skill's qualified name. */
  toolSource: string
  /** Args the handler actually received (or would have received, in the
   *  case of a denied/mocked call). Already validated against the tool's
   *  Zod schema and threaded through any prior pre-hooks. Post-hooks see
   *  the same args the handler did. */
  args: unknown
}

export type PreHookResult =
  /** Allow the call; if `args` is set, replace the validated args. */
  | { decision: 'allow'; args?: unknown }
  /** Reject the call. The agent sees a recoverable PERMISSION_DENIED. */
  | { decision: 'deny'; reason: string }
  /** Skip the handler entirely; use this result. Post-hooks still run. */
  | { decision: 'mock'; result: ToolResult }

export type PostHookResult =
  | { transform: 'pass' }
  | { transform: 'replace'; result: ToolResult }

export interface PreToolHook {
  name: string
  /**
   * Tool-id selectors. The hook only runs when `ctx.toolId` matches at
   * least one pattern. Patterns: exact id (`wiki_read`), prefix wildcard
   * (`wiki_*`), or `*` for all. Omit/empty = matches all (backward-compat
   * with hooks that handle their own filtering).
   */
  match?: readonly string[]
  fn(
    args: unknown,
    ctx: ToolHookContext,
  ): Promise<PreHookResult> | PreHookResult
}

export interface PostToolHook {
  name: string
  /** See PreToolHook.match. */
  match?: readonly string[]
  fn(
    result: ToolResult,
    ctx: ToolHookContext,
  ): Promise<PostHookResult> | PostHookResult
}

/**
 * Build a pre-hook that denies any tool call whose id matches one of the
 * given patterns. Used to enforce profile-declared `deny_tools` lists.
 * The hook itself doesn't restrict via `match: ...` — it inspects ctx.toolId
 * dynamically so a single instance covers any number of patterns and
 * surfaces a useful reason string back to the agent.
 */
export function buildDenyToolsHook(patterns: readonly string[]): PreToolHook {
  return {
    name: 'profile-deny-tools',
    fn(_args, ctx) {
      for (const p of patterns) {
        if (matchesToolId([p], ctx.toolId)) {
          return {
            decision: 'deny',
            reason: `tool "${ctx.toolId}" denied by agent profile "${ctx.agentProfile}" (deny_tools: "${p}")`,
          }
        }
      }
      return { decision: 'allow' }
    },
  }
}

/**
 * Test whether a tool id matches at least one of the given patterns.
 * Patterns: literal match, prefix-with-wildcard (`wiki_*`), or `*`.
 * An empty/undefined pattern list is treated as match-all (preserves
 * pre-extension hook behavior).
 *
 * Exported for testing.
 */
export function matchesToolId(patterns: readonly string[] | undefined, toolId: string): boolean {
  if (!patterns || patterns.length === 0) return true
  for (const p of patterns) {
    if (p === '*' || p === toolId) return true
    if (p.endsWith('*') && toolId.startsWith(p.slice(0, -1))) return true
  }
  return false
}

/** Result of running the pre-chain — what the registry should do next. */
export type PreChainOutcome =
  | { kind: 'allow'; args: unknown }
  | { kind: 'deny'; reason: string; byHook: string }
  | { kind: 'mock'; result: ToolResult; byHook: string }

export class HookRegistry {
  private readonly preHooks: PreToolHook[] = []
  private readonly postHooks: PostToolHook[] = []

  addPreHook(hook: PreToolHook): void {
    this.preHooks.push(hook)
  }

  addPostHook(hook: PostToolHook): void {
    this.postHooks.push(hook)
  }

  hasAny(): boolean {
    return this.preHooks.length > 0 || this.postHooks.length > 0
  }

  /**
   * Run all pre-hooks in registration order. The first hook that denies or
   * mocks short-circuits the chain. Otherwise args thread through, allowing
   * each hook to mutate them for the next.
   */
  async runPre(args: unknown, ctx: Omit<ToolHookContext, 'args'>): Promise<PreChainOutcome> {
    let currentArgs = args
    for (const hook of this.preHooks) {
      if (!matchesToolId(hook.match, ctx.toolId)) continue
      const r = await hook.fn(currentArgs, { ...ctx, args: currentArgs })
      if (r.decision === 'deny') {
        return { kind: 'deny', reason: r.reason, byHook: hook.name }
      }
      if (r.decision === 'mock') {
        return { kind: 'mock', result: r.result, byHook: hook.name }
      }
      if (r.args !== undefined) currentArgs = r.args
    }
    return { kind: 'allow', args: currentArgs }
  }

  /**
   * Run all post-hooks in registration order. A hook may replace the
   * result; subsequent hooks see the replacement. No short-circuit — every
   * post-hook always runs (audit-log hooks need to see final results).
   */
  async runPost(
    result: ToolResult,
    ctx: ToolHookContext,
  ): Promise<ToolResult> {
    let current = result
    for (const hook of this.postHooks) {
      if (!matchesToolId(hook.match, ctx.toolId)) continue
      const r = await hook.fn(current, ctx)
      if (r.transform === 'replace') current = r.result
    }
    return current
  }

  /**
   * Build a new HookRegistry that inherits pre + post hooks from this one
   * plus any extras. Used to compose per-session registries that include
   * cross-cutting hooks (audit, redaction) from the server config and
   * per-profile policy hooks (deny lists) from the agent profile.
   */
  compose(extras: { pre?: PreToolHook[]; post?: PostToolHook[] }): HookRegistry {
    const out = new HookRegistry()
    for (const h of this.preHooks) out.preHooks.push(h)
    for (const h of this.postHooks) out.postHooks.push(h)
    for (const h of extras.pre ?? []) out.preHooks.push(h)
    for (const h of extras.post ?? []) out.postHooks.push(h)
    return out
  }
}

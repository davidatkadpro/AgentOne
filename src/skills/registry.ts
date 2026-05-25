import type { RegisteredTool, ToolContext, ToolResult } from './tool.js'
import { fail } from './tool.js'
import type { ToolDefinition } from '../core/types.js'
import { zodToJsonSchema } from './zod-to-json.js'
import type { HookRegistry, ToolHookContext } from './hooks.js'
import type { EventBus } from '../core/events.js'

export interface ToolExecutionResult {
  result: ToolResult
  durationMs: number
}

/**
 * Called by `execute` when a tool id isn't registered. If the resolver loads
 * the missing tool (e.g. by auto-loading the skill that declares it), it
 * returns `true` and `execute` retries the lookup once.
 */
export type UnknownToolResolver = (id: string) => Promise<boolean>

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Session-scoped catalogue of callable tools. Core Tools register at session
 * start; skill-supplied tools register on `load_skill` and live for the rest
 * of the session.
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()
  private cachedDefs: ToolDefinition[] | null = null
  private resolveUnknown?: UnknownToolResolver

  constructor(
    private readonly hooks?: HookRegistry,
    private readonly eventBus?: EventBus,
  ) {}

  /**
   * Install a fallback resolver that runs when `execute` hits an unknown
   * tool id. Used by the orchestrator to auto-load the skill that owns a
   * tool the model called without first invoking `load_skill`.
   */
  setUnknownToolResolver(fn: UnknownToolResolver | undefined): void {
    this.resolveUnknown = fn
  }

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool already registered: ${tool.id}`)
    }
    this.tools.set(tool.id, tool)
    this.cachedDefs = null
  }

  has(id: string): boolean {
    return this.tools.has(id)
  }

  get(id: string): RegisteredTool | undefined {
    return this.tools.get(id)
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()]
  }

  /** OpenAI-compatible tool definitions for the current registered set.
   *  Cached because the tool set only mutates on `register`. */
  toolDefinitions(): ToolDefinition[] {
    if (this.cachedDefs) return this.cachedDefs
    this.cachedDefs = this.list().map((t) => ({
      type: 'function',
      function: {
        name: t.id,
        description: t.description,
        parameters: zodToJsonSchema(t.parameters),
      },
    }))
    return this.cachedDefs
  }

  /**
   * Execute a tool by id with the model's raw JSON argument string.
   * Always returns a structured ToolResult — exceptions are wrapped.
   * Enforces a per-tool timeout (default 10s) via Promise.race.
   */
  async execute(
    id: string,
    argsRaw: string,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const start = Date.now()
    let tool = this.tools.get(id)
    if (!tool && this.resolveUnknown) {
      let recovered = false
      try {
        recovered = await this.resolveUnknown(id)
      } catch {
        recovered = false
      }
      if (recovered) tool = this.tools.get(id)
    }
    if (!tool) {
      return wrap(start, fail('TOOL_VALIDATION', `Unknown tool: ${id}`, false))
    }

    let parsedArgs: unknown
    if (argsRaw.trim().length === 0) {
      parsedArgs = {}
    } else {
      try {
        parsedArgs = JSON.parse(argsRaw)
      } catch (err) {
        return wrap(
          start,
          fail(
            'TOOL_VALIDATION',
            `Arguments are not valid JSON: ${(err as Error).message}`,
            true,
          ),
        )
      }
    }

    const validation = tool.parameters.safeParse(parsedArgs)
    if (!validation.success) {
      return wrap(
        start,
        fail(
          'TOOL_VALIDATION',
          `Arguments failed schema validation: ${validation.error.message}`,
          true,
          { issues: validation.error.issues },
        ),
      )
    }

    const timeoutMs = tool.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const partialHookCtx: Omit<ToolHookContext, 'args'> = {
      sessionId: ctx.sessionId,
      agentProfile: ctx.agentProfile,
      toolId: id,
      toolSource: tool.source,
    }

    // Pre-hook chain. Fails closed: a hook crash becomes TOOL_RUNTIME and the
    // handler never runs.
    let effectiveArgs: unknown = validation.data
    let mockedResult: ToolResult | null = null
    if (this.hooks) {
      let preOutcome
      try {
        preOutcome = await this.hooks.runPre(validation.data, partialHookCtx)
      } catch (err) {
        return wrap(
          start,
          fail(
            'TOOL_RUNTIME',
            `Pre-hook crashed: ${err instanceof Error ? err.message : String(err)}`,
            false,
          ),
        )
      }
      if (preOutcome.kind === 'deny') {
        void this.eventBus?.emit({
          type: 'tool.hook_denied',
          sessionId: ctx.sessionId,
          tool: id,
          hook: preOutcome.byHook,
          reason: preOutcome.reason,
          ts: Date.now(),
        })
        return wrap(
          start,
          fail(
            'PERMISSION_DENIED',
            `Tool ${id} denied by hook "${preOutcome.byHook}": ${preOutcome.reason}`,
            false,
          ),
        )
      }
      if (preOutcome.kind === 'mock') {
        void this.eventBus?.emit({
          type: 'tool.hook_mocked',
          sessionId: ctx.sessionId,
          tool: id,
          hook: preOutcome.byHook,
          ts: Date.now(),
        })
        mockedResult = normaliseResult(preOutcome.result)
      } else {
        effectiveArgs = preOutcome.args
      }
    }

    let handlerResult: ToolResult
    if (mockedResult !== null) {
      handlerResult = mockedResult
    } else {
      try {
        const r = await raceTimeout(
          Promise.resolve(tool.handler(effectiveArgs as never, ctx)),
          timeoutMs,
        )
        handlerResult = normaliseResult(r)
      } catch (err) {
        if (err instanceof TimeoutError) {
          handlerResult = fail(
            'TOOL_TIMEOUT',
            `Tool ${id} exceeded timeout of ${timeoutMs}ms`,
            false,
          )
        } else {
          handlerResult = fail(
            'TOOL_RUNTIME',
            err instanceof Error ? err.message : String(err),
            false,
            err instanceof Error && err.stack ? { stack: err.stack } : undefined,
          )
        }
      }
    }

    // Post-hook chain. Every hook always runs (audit hooks need to see the
    // final result even on failure). Fails closed.
    if (this.hooks) {
      try {
        handlerResult = await this.hooks.runPost(handlerResult, {
          ...partialHookCtx,
          args: effectiveArgs,
        })
      } catch (err) {
        return wrap(
          start,
          fail(
            'TOOL_RUNTIME',
            `Post-hook crashed: ${err instanceof Error ? err.message : String(err)}`,
            false,
          ),
        )
      }
    }

    return wrap(start, handlerResult)
  }
}

class TimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`Timeout ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
  })
  try {
    return (await Promise.race([p, timeout])) as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normaliseResult(r: unknown): ToolResult {
  if (r && typeof r === 'object' && 'ok' in r) return r as ToolResult
  return { ok: true, value: r }
}

function wrap(start: number, result: ToolResult): ToolExecutionResult {
  return { result, durationMs: Date.now() - start }
}

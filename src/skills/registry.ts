import type { RegisteredTool, ToolContext, ToolResult } from './tool.js'
import { fail } from './tool.js'
import type { ToolDefinition } from '../core/types.js'
import { zodToJsonSchema } from './zod-to-json.js'

export interface ToolExecutionResult {
  result: ToolResult
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Session-scoped catalogue of callable tools. Core Tools register at session
 * start; skill-supplied tools register on `load_skill` and live for the rest
 * of the session.
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()
  private cachedDefs: ToolDefinition[] | null = null

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
    const tool = this.tools.get(id)
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

    try {
      const result = await raceTimeout(
        Promise.resolve(tool.handler(validation.data, ctx)),
        timeoutMs,
      )
      return wrap(start, normaliseResult(result))
    } catch (err) {
      if (err instanceof TimeoutError) {
        return wrap(
          start,
          fail('TOOL_TIMEOUT', `Tool ${id} exceeded timeout of ${timeoutMs}ms`, false),
        )
      }
      return wrap(
        start,
        fail(
          'TOOL_RUNTIME',
          err instanceof Error ? err.message : String(err),
          false,
          err instanceof Error && err.stack ? { stack: err.stack } : undefined,
        ),
      )
    }
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

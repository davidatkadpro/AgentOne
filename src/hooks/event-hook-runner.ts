import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { z } from 'zod'
import type { AgentEvent, EventBus, EventType } from '../core/events.js'

/** YAML entry shape: `on` is an event type or `*`, `handler` is a path. */
const HookEntrySchema = z.object({
  on: z.string().min(1),
  handler: z.string().min(1),
  /** Optional per-hook description for logging. */
  description: z.string().optional(),
})
const HookConfigSchema = z.array(HookEntrySchema)

export type RawHookEntry = z.infer<typeof HookEntrySchema>

export type EventHookHandler = (event: AgentEvent) => Promise<void> | void

interface LoadedHook {
  on: EventType | '*'
  handler: EventHookHandler
  source: string
}

export interface EventHookRunnerConfig {
  hooks: LoadedHook[]
  /** Override for testing — defaults to console.error. */
  onHandlerError?: (hook: LoadedHook, err: unknown) => void
}

/**
 * Reads event-hook declarations from a YAML file and runs the listed
 * handlers on matching bus events. Trusted, in-process — handlers ship
 * as TypeScript/JavaScript modules with a default export of an async
 * function `(event) => void`.
 *
 * Errors thrown by a handler are caught and logged; they never propagate
 * back into the orchestrator or bus emission. PRD #63.
 */
export class EventHookRunner {
  private unsubscribe: (() => void) | null = null

  constructor(private readonly cfg: EventHookRunnerConfig) {}

  start(bus: EventBus): void {
    if (this.unsubscribe) return
    this.unsubscribe = bus.onAny((event) => {
      this.dispatch(event)
    })
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  /** Exposed for tests so they can drive a single event through synchronously. */
  dispatch(event: AgentEvent): void {
    for (const hook of this.cfg.hooks) {
      if (hook.on !== '*' && hook.on !== event.type) continue
      const onError = this.cfg.onHandlerError ?? defaultOnError
      try {
        const result = hook.handler(event)
        if (result && typeof (result as Promise<void>).then === 'function') {
          ;(result as Promise<void>).catch((err: unknown) => {
            onError(hook, err)
          })
        }
      } catch (err) {
        onError(hook, err)
      }
    }
  }

  /** Number of currently-loaded hooks. Exposed for tests + startup logs. */
  hookCount(): number {
    return this.cfg.hooks.length
  }
}

function defaultOnError(hook: LoadedHook, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(
    `[event-hook:${hook.source}] handler threw: ${err instanceof Error ? err.message : String(err)}`,
  )
}

/**
 * Load and validate hook entries from a YAML file, dynamically importing
 * each handler module. Returns null when the file doesn't exist so a
 * missing config is a non-event, not an error.
 *
 * The YAML format is a list of `{ on, handler, description? }` entries.
 * Handler paths are resolved relative to the config file's directory.
 */
export async function loadEventHooks(configPath: string): Promise<EventHookRunner | null> {
  let raw: string
  try {
    raw = await readFile(configPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed = yaml.load(raw)
  const validated = HookConfigSchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(
      `Invalid event hooks config at ${configPath}: ${validated.error.message}`,
    )
  }
  const configDir = dirname(configPath)
  const loaded: LoadedHook[] = []
  for (const entry of validated.data) {
    const handlerPath = isAbsolute(entry.handler)
      ? entry.handler
      : resolvePath(configDir, entry.handler)
    const url = pathToFileURL(handlerPath).href
    const mod = (await import(url)) as { default?: EventHookHandler }
    if (typeof mod.default !== 'function') {
      throw new Error(
        `Event hook "${entry.handler}" has no default export function`,
      )
    }
    loaded.push({
      on: entry.on as EventType | '*',
      handler: mod.default,
      source: entry.description ?? entry.handler,
    })
  }
  return new EventHookRunner({ hooks: loaded })
}

import type { CommandModule, CommandContext, CommandResult } from './types.js'

export const RESERVED_COMMAND_NAMES = new Set([
  'new',
  'help',
  'load',
  'compact',
  'sessions',
  'clear',
])

/**
 * Holds system commands keyed by name. Skill slash_commands are NOT registered
 * here — they live in SkillIndex.bySlashCommand and are dispatched by the
 * outer router after the system registry misses.
 */
export class CommandRegistry {
  private modules = new Map<string, CommandModule>()

  register(mod: CommandModule): void {
    if (this.modules.has(mod.name)) {
      throw new Error(`Duplicate command: ${mod.name}`)
    }
    this.modules.set(mod.name, mod)
  }

  has(name: string): boolean {
    return this.modules.has(name)
  }

  get(name: string): CommandModule | undefined {
    return this.modules.get(name)
  }

  list(): CommandModule[] {
    return [...this.modules.values()]
  }

  async dispatch(
    name: string,
    rawArgs: Record<string, unknown>,
    ctx: CommandContext,
  ): Promise<CommandResult> {
    const mod = this.modules.get(name)
    if (!mod) {
      return {
        kind: 'error',
        message: `Unknown command: /${name}`,
        recoverable: true,
      }
    }
    if (mod.requiresSession && !ctx.sessionId) {
      return {
        kind: 'error',
        message: `/${name} requires an active session`,
        recoverable: true,
      }
    }
    const parsed = mod.args.safeParse(rawArgs)
    if (!parsed.success) {
      return {
        kind: 'error',
        message: `Invalid arguments to /${name}: ${parsed.error.message}`,
        recoverable: true,
      }
    }
    try {
      return await mod.handler(parsed.data, ctx)
    } catch (err) {
      // Bubble stack to the server log so a handler bug is debuggable; the
      // wire response only carries a short message.
      // eslint-disable-next-line no-console
      console.error(`[command:/${name}] handler threw:`, err)
      return {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      }
    }
  }
}

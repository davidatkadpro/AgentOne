import type { z } from 'zod'
import type { ConversationStore } from '../../storage/sqlite.js'
import type { SkillIndex } from '../../skills/loader.js'
import type { Orchestrator } from '../../orchestrator/turn.js'
import type { ContextManager } from '../../context/context-manager.js'
import type { ServerConfig } from '../config.js'
import type { Session } from '../../core/types.js'

/**
 * Runtime services a system-command handler may use. Held separately from
 * ToolServices because commands operate at the session/server level rather
 * than inside an agent turn.
 */
export interface CommandContext {
  /** Session the command was issued from. Some commands ignore this (e.g. /new). */
  sessionId: string | null
  store: ConversationStore
  skillIndex: SkillIndex
  orchestrator: Orchestrator
  contextManager: ContextManager
  config: ServerConfig
}

/** Discriminated union mirroring what the frontend can render. */
export type CommandResult =
  | { kind: 'text'; content: string }
  | { kind: 'session_list'; sessions: SessionSummary[] }
  | { kind: 'session_switch'; session: Session; reason: 'new' | 'switched' }
  | { kind: 'session_cleared'; sessionId: string; turnsDeleted: number }
  | {
      kind: 'skill_loaded'
      skill: string
      toolsRegistered: string[]
      alreadyLoaded: boolean
    }
  | {
      kind: 'context_compacted'
      sessionId: string
      tokensBefore: number
      tokensAfter: number
      changed: boolean
    }
  | { kind: 'skill_invoked'; skill: string; forwarded: boolean; alreadyLoaded: boolean }
  | { kind: 'error'; message: string; recoverable: boolean }

export interface SessionSummary {
  id: string
  title: string | null
  agentProfile: string
  createdAt: number
  turnCount: number
}

export interface CommandModule<Args extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  /** Short usage line, e.g. `/sessions [limit]`. */
  usage: string
  /** Zod schema applied to the parsed argument object. */
  args: Args
  /** True if the command requires a current sessionId. */
  requiresSession: boolean
  handler: (args: z.infer<Args>, ctx: CommandContext) => Promise<CommandResult>
}

/**
 * Constructor helper. Lets a module write a strongly-typed handler against
 * its own zod schema, but erases the generic at the return type so the
 * registry can store heterogeneous CommandModules without variance gymnastics.
 */
export function defineCommand<Args extends z.ZodTypeAny>(
  spec: CommandModule<Args>,
): CommandModule {
  return spec as unknown as CommandModule
}

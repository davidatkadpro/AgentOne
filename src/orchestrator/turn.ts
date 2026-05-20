import { randomUUID } from 'node:crypto'
import type { ConversationStore } from '../storage/sqlite.js'
import { turnsToMessages } from '../storage/sqlite.js'
import { countMessagesTokens } from '../core/tokenizer.js'
import type { ContextManager } from '../context/context-manager.js'
import type { Provider } from '../providers/base.js'
import type { Message, ModelProfile, ToolCallSpec } from '../core/types.js'
import { EventBus } from '../core/events.js'
import type { SkillIndex } from '../skills/loader.js'
import { importSkillTools } from '../skills/loader.js'
import { ToolRegistry } from '../skills/registry.js'
import type { ToolContext, ToolServices } from '../skills/tool.js'
import { buildCoreSkillTools } from '../skills/core-tools.js'
import { buildWikiCoreTools } from '../skills/wiki-core-tools.js'
import { buildHistoryCoreTools } from '../skills/history-core-tools.js'
import type { ResolvedAgentProfile } from '../profiles/agent-profile.js'
import { PermissionGate } from '../profiles/permission-gate.js'
import { composeSystemMessage } from '../context/prompt-composer.js'

export interface OrchestratorConfig {
  store: ConversationStore
  contextManager: ContextManager
  provider: Provider
  conversationModel: ModelProfile
  eventBus: EventBus
  skillIndex: SkillIndex
  profile: ResolvedAgentProfile
  basePrompt: string
  services: ToolServices
  /** Cap on tool-loop iterations to prevent runaway agents. */
  maxIterations?: number
  /** Max session states to keep in memory. Oldest evicted FIFO. */
  sessionCacheMax?: number
}

export interface TurnHandle {
  stream: AsyncIterable<string>
}

interface SessionState {
  sessionId: string
  registry: ToolRegistry
  loadedSkills: Set<string>
  permissions: PermissionGate
  systemMessage: Message
}

const DEFAULT_MAX_ITERATIONS = 8
const DEFAULT_SESSION_CACHE_MAX = 32

const MAX_ITER_HIT_NOTICE =
  '[Tool loop terminated: iteration cap reached. The agent issued more tool calls than permitted in a single user message. Re-prompt to continue.]'

const EMPTY_TURN_NOTICE =
  '[The model produced no response. This usually means an empty tool result confused it. Try rephrasing, or send another message to nudge it.]'

/**
 * Multi-turn tool-calling orchestrator. Owns a per-session ToolRegistry
 * (Core tools + tools registered by loaded skills), runs the model in a loop
 * that executes tool calls between iterations, and persists each iteration's
 * assistant turn + tool calls to the store.
 */
export class Orchestrator {
  private readonly maxIterations: number
  private readonly sessionCacheMax: number
  private sessions = new Map<string, Promise<SessionState>>()

  constructor(private readonly cfg: OrchestratorConfig) {
    this.maxIterations = cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS
    this.sessionCacheMax = cfg.sessionCacheMax ?? DEFAULT_SESSION_CACHE_MAX
  }

  async handleUserMessage(sessionId: string, userText: string): Promise<TurnHandle> {
    const state = await this.getSessionState(sessionId)
    const userTurn = this.cfg.store.appendTurn({
      sessionId,
      role: 'user',
      content: userText,
    })
    await this.cfg.eventBus.emit({
      type: 'message.user.received',
      sessionId,
      turnId: userTurn.id,
      ts: Date.now(),
    })
    return { stream: this.runToolLoop(state) }
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * Manually load a skill into an existing session (e.g. via /load slash
   * command). Returns enough detail for the caller to distinguish:
   * already-loaded, freshly loaded with N tools, denied by permissions, or
   * load-failed with a reason.
   */
  async loadSkillIntoSession(
    sessionId: string,
    skillName: string,
  ): Promise<
    | { alreadyLoaded: true; toolsRegistered: [] }
    | { alreadyLoaded: false; loaded: true; toolsRegistered: string[] }
    | { alreadyLoaded: false; loaded: false; reason: string }
  > {
    const state = await this.getSessionState(sessionId)
    if (state.loadedSkills.has(skillName)) {
      return { alreadyLoaded: true, toolsRegistered: [] }
    }
    const result = await this.loadSkillIntoRegistry({
      skillName,
      registry: state.registry,
      loadedSkills: state.loadedSkills,
      permissions: state.permissions,
      sessionId,
    })
    if (!result.loaded) {
      return { alreadyLoaded: false, loaded: false, reason: result.reason ?? 'unknown' }
    }
    return { alreadyLoaded: false, loaded: true, toolsRegistered: result.toolsRegistered }
  }

  /**
   * Build the current history-as-messages and ask the ContextManager to
   * compress regardless of threshold. Returns the token deltas.
   */
  async compactSession(
    sessionId: string,
  ): Promise<{ tokensBefore: number; tokensAfter: number; changed: boolean }> {
    const state = await this.getSessionState(sessionId)
    const turns = this.cfg.store.listTurns(sessionId)
    const toolCallsMap = this.cfg.store.listToolCallsBySession(sessionId)
    const history = turnsToMessages(turns, toolCallsMap)
    return this.cfg.contextManager.compactNow(sessionId, state.systemMessage, history)
  }

  private async loadSkillIntoRegistry(args: {
    skillName: string
    registry: ToolRegistry
    loadedSkills: Set<string>
    permissions: PermissionGate
    sessionId: string
  }): Promise<{ toolsRegistered: string[]; loaded: boolean; reason?: string }> {
    const { skillName, registry, loadedSkills, permissions, sessionId } = args
    const manifest = this.cfg.skillIndex.skills.get(skillName)
    if (!manifest) {
      const reason = 'not found in skill index'
      await this.cfg.eventBus.emit({
        type: 'skill.load_failed',
        sessionId,
        name: skillName,
        reason,
        ts: Date.now(),
      })
      return { toolsRegistered: [], loaded: false, reason }
    }
    const decision = permissions.canLoadSkill(skillName)
    if (decision.verdict === 'deny') {
      return {
        toolsRegistered: [],
        loaded: false,
        reason: `permission denied: ${decision.reason}`,
      }
    }
    await this.cfg.eventBus.emit({
      type: 'skill.loading',
      sessionId,
      name: skillName,
      ts: Date.now(),
    })
    try {
      const tools = await importSkillTools(manifest)
      const registered: string[] = []
      for (const t of tools) {
        if (registry.has(t.id)) {
          await this.cfg.eventBus.emit({
            type: 'skill.load_failed',
            sessionId,
            name: skillName,
            reason: `tool id collision: ${t.id}`,
            ts: Date.now(),
          })
          continue
        }
        registry.register({
          id: t.id,
          description: t.description,
          parameters: t.module.parameters,
          handler: t.module.handler,
          source: skillName,
        })
        registered.push(t.id)
      }
      loadedSkills.add(skillName)
      await this.cfg.eventBus.emit({
        type: 'skill.loaded',
        sessionId,
        name: skillName,
        toolsRegistered: registered,
        ts: Date.now(),
      })
      return { toolsRegistered: registered, loaded: true }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await this.cfg.eventBus.emit({
        type: 'skill.load_failed',
        sessionId,
        name: skillName,
        reason,
        ts: Date.now(),
      })
      return { toolsRegistered: [], loaded: false, reason }
    }
  }

  private getSessionState(sessionId: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      // Promote to most-recently-used so the FIFO eviction approximates LRU.
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, existing)
      return existing
    }
    if (this.sessions.size >= this.sessionCacheMax) {
      const oldest = this.sessions.keys().next().value
      if (oldest !== undefined) this.sessions.delete(oldest)
    }
    const built = this.buildSessionState(sessionId).catch((err) => {
      // Failed builds must not stay cached; the next message should retry.
      this.sessions.delete(sessionId)
      throw err
    })
    this.sessions.set(sessionId, built)
    return built
  }

  private async buildSessionState(sessionId: string): Promise<SessionState> {
    const registry = new ToolRegistry()
    const loadedSkills = new Set<string>()
    const permissions = new PermissionGate(this.cfg.profile)

    for (const t of buildCoreSkillTools({
      index: this.cfg.skillIndex,
      registry,
      permissions,
      bus: this.cfg.eventBus,
      sessionId,
      loadedSkills,
    })) {
      registry.register(t)
    }

    for (const t of buildWikiCoreTools()) {
      registry.register(t)
    }

    for (const t of buildHistoryCoreTools()) {
      registry.register(t)
    }

    // Default skills are surfaced in the system prompt by header (name +
    // description) but NOT eagerly loaded — their tool schemas would cost
    // ~8 entries in context on every turn. The model calls `load_skill` on
    // first use, which imports the handlers and registers the tools for the
    // rest of the session.
    const defaultSkillHeaders = this.cfg.profile.defaultSkills
      .map((qn) => this.cfg.skillIndex.skills.get(qn))
      .filter((m): m is NonNullable<typeof m> => Boolean(m))
      .map((m) => ({
        name: m.qualifiedName,
        description: m.description,
      }))

    const categories = [...this.cfg.skillIndex.categories.values()].map((c) => ({
      name: c.name,
      description: c.description,
    }))

    const systemMessage = composeSystemMessage({
      basePrompt: this.cfg.basePrompt,
      defaultSkills: defaultSkillHeaders,
      categories,
    })

    return { sessionId, registry, loadedSkills, permissions, systemMessage }
  }

  private async *runToolLoop(state: SessionState): AsyncIterable<string> {
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let finalTurnId: string | null = null

    // Build history once before the loop. Subsequent iterations append the
    // newly-persisted assistant turn and synthesized tool results in-memory
    // so we don't re-query/re-tokenize the whole conversation each pass.
    const initialTurns = this.cfg.store.listTurns(state.sessionId)
    const toolCallsMap = this.cfg.store.listToolCallsBySession(state.sessionId)
    let history = turnsToMessages(initialTurns, toolCallsMap)

    try {
      for (let iter = 0; iter < this.maxIterations; iter++) {
        const historyTokens = countMessagesTokens(history)
        const prepared = await this.cfg.contextManager.prepare(
          state.sessionId,
          state.systemMessage,
          history,
          { historyTokens },
        )

        const iterationTurnId = randomUUID()
        await this.cfg.eventBus.emit({
          type: 'message.assistant.started',
          sessionId: state.sessionId,
          turnId: iterationTurnId,
          ts: Date.now(),
        })

        let collected = ''
        let toolCalls: ToolCallSpec[] = []
        let iterInput = 0
        let iterOutput = 0

        for await (const chunk of this.cfg.provider.stream({
          model: this.cfg.conversationModel.model,
          messages: prepared.messages,
          tools: state.registry.toolDefinitions(),
          toolChoice: 'auto',
          temperature: this.cfg.conversationModel.params.temperature ?? 0.4,
          maxTokens: this.cfg.conversationModel.params.maxTokens ?? 2048,
          topP: this.cfg.conversationModel.params.topP ?? 1,
        })) {
          if (chunk.delta) {
            collected += chunk.delta
            void this.cfg.eventBus.emit({
              type: 'message.assistant.delta',
              sessionId: state.sessionId,
              turnId: iterationTurnId,
              delta: chunk.delta,
            })
            yield chunk.delta
          }
          if (chunk.done) {
            if (chunk.toolCalls && chunk.toolCalls.length > 0) toolCalls = chunk.toolCalls
            iterInput = chunk.inputTokens ?? 0
            iterOutput = chunk.outputTokens ?? 0
          }
        }

        totalInputTokens += iterInput
        totalOutputTokens += iterOutput

        // When the model finishes without tool calls and produced no text,
        // stream a placeholder so the UI shows something actionable. The
        // notice is NOT persisted to `turns.content` — turnsToMessages
        // would otherwise replay it back to the model on the next iteration
        // and the model would treat its own former silence as a real prior
        // message. Empty assistant turns are filtered out at history rebuild.
        if (toolCalls.length === 0 && collected.trim().length === 0) {
          void this.cfg.eventBus.emit({
            type: 'message.assistant.delta',
            sessionId: state.sessionId,
            turnId: iterationTurnId,
            delta: EMPTY_TURN_NOTICE,
          })
          yield EMPTY_TURN_NOTICE
        }

        const assistantTurn = this.cfg.store.appendTurn({
          sessionId: state.sessionId,
          role: 'assistant',
          content: collected,
        })

        if (toolCalls.length === 0) {
          finalTurnId = assistantTurn.id
          return
        }

        // Append the assistant message + (eventually) tool results to the
        // in-memory history. Tool result strings get filled in below.
        const toolMessagesByCallId = new Map<string, Message>()
        history.push({
          role: 'assistant',
          content: collected.length > 0 ? collected : null,
          tool_calls: toolCalls,
        })
        for (const call of toolCalls) {
          const placeholder: Message = {
            role: 'tool',
            tool_call_id: call.id,
            content: '',
          }
          toolMessagesByCallId.set(call.id, placeholder)
          history.push(placeholder)
        }

        const ctx: ToolContext = {
          sessionId: state.sessionId,
          agentProfile: this.cfg.profile.id,
          services: this.cfg.services,
        }
        for (const call of toolCalls) {
          const row = this.cfg.store.appendToolCall({
            turnId: assistantTurn.id,
            toolCallId: call.id,
            tool: call.function.name,
            argsJson: call.function.arguments,
          })

          await this.cfg.eventBus.emit({
            type: 'tool.called',
            sessionId: state.sessionId,
            turnId: assistantTurn.id,
            toolCallId: call.id,
            tool: call.function.name,
            args: safeParseJson(call.function.arguments),
            ts: Date.now(),
          })

          const exec = await state.registry.execute(
            call.function.name,
            call.function.arguments,
            ctx,
          )
          const resultJson = stringifyResult(exec.result)
          this.cfg.store.recordToolCallResult({
            id: row.id,
            resultJson,
            ok: exec.result.ok,
            durationMs: exec.durationMs,
          })

          const placeholder = toolMessagesByCallId.get(call.id)
          if (placeholder) placeholder.content = resultJson

          if (exec.result.ok) {
            await this.cfg.eventBus.emit({
              type: 'tool.completed',
              sessionId: state.sessionId,
              turnId: assistantTurn.id,
              toolCallId: call.id,
              tool: call.function.name,
              ok: true,
              durationMs: exec.durationMs,
              ts: Date.now(),
            })
          } else {
            await this.cfg.eventBus.emit({
              type: 'tool.failed',
              sessionId: state.sessionId,
              turnId: assistantTurn.id,
              toolCallId: call.id,
              tool: call.function.name,
              code: exec.result.error.code,
              message: exec.result.error.message,
              ts: Date.now(),
            })
          }
        }
      }

      // Hit the iteration cap. Persist a terminal assistant turn so the model
      // (and the UI) see an explicit "I was cut off" message and the next
      // user turn picks up cleanly.
      const cappedTurn = this.cfg.store.appendTurn({
        sessionId: state.sessionId,
        role: 'assistant',
        content: MAX_ITER_HIT_NOTICE,
      })
      finalTurnId = cappedTurn.id
    } finally {
      await this.cfg.eventBus.emit({
        type: 'message.assistant.completed',
        sessionId: state.sessionId,
        turnId: finalTurnId ?? randomUUID(),
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        ts: Date.now(),
      })
    }
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function stringifyResult(result: unknown): string {
  try {
    return JSON.stringify(result)
  } catch {
    return JSON.stringify({ ok: false, error: 'unserialisable result' })
  }
}

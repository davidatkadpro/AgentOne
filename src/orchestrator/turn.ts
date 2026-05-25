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
import { buildRequestUserInputTool } from '../skills/request-user-input-tool.js'
import type { ResolvedAgentProfile } from '../profiles/agent-profile.js'
import { PermissionGate } from '../profiles/permission-gate.js'
import { composeSystemMessage } from '../context/prompt-composer.js'
import { ExpertSpendTracker } from '../skills/expert-spend.js'
import { HookRegistry, buildDenyToolsHook } from '../skills/hooks.js'
import {
  buildPassiveRecall,
  recallToMessage,
  type PassiveRecallConfig,
  type PassiveRecallResult,
} from '../context/passive-recall.js'

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
  /** Optional cross-cutting tool hooks (redaction, audit, deny rules). Shared
   *  across sessions for now; per-profile config is a future extension. */
  hooks?: HookRegistry
  /** Passive-recall configuration. When enabled, every user turn triggers a
   *  best-effort wiki + cross-session history probe that's injected into the
   *  prompt as a "Possibly relevant context" block. Disabled by default. */
  passiveRecall?: PassiveRecallConfig
  /** Cap on tool-loop iterations to prevent runaway agents. */
  maxIterations?: number
  /** Max session states to keep in memory. Oldest evicted FIFO. */
  sessionCacheMax?: number
}

export interface TurnHandle {
  stream: AsyncIterable<string>
}

export interface SpawnSessionInput {
  /** Provenance string recorded on the session row and emitted on
   *  `session.spawned`. Free-form — e.g. `modules/email`,
   *  `http://api/email/actions`, `scheduler/auto-distill`. */
  spawnedBy: string
  /** The first user message the orchestrator runs immediately. Mandatory —
   *  spawnSession is the "kick off work" entry point. Sessions created with
   *  no seed message should use store.createSession directly. */
  initialMessage: string
  /** Optional title persisted on the session row. The auto-titler still runs
   *  on the first turn for sessions left untitled. */
  title?: string
  /** Optional. Defaults to the orchestrator's boot profile. */
  agentProfile?: string
  /** Skills to load into the session before the first turn runs. Each entry
   *  is a qualifiedName (e.g. `email/file-to-project`). Skills that fail
   *  to load (not in index, permission-denied, broken handler) are skipped
   *  rather than aborting the spawn — the action will still run, just
   *  without those tools. */
  allowedSkills?: string[]
}

export interface SpawnSessionResult {
  session: import('../core/types.js').Session
  handle: TurnHandle
}

interface SessionState {
  sessionId: string
  registry: ToolRegistry
  loadedSkills: Set<string>
  permissions: PermissionGate
  systemMessage: Message
  expertSpend: ExpertSpendTracker
  /**
   * AbortController for the in-flight turn, or null between turns. Replaced
   * on each handleUserMessage. cancelSession() aborts this controller — the
   * orchestrator's loop checks signal.aborted between iterations, providers
   * receive it via ChatRequest.signal, and tool handlers see it on ctx.signal.
   */
  currentCancellation: AbortController | null
}

const DEFAULT_MAX_ITERATIONS = 8
const DEFAULT_SESSION_CACHE_MAX = 32

/**
 * Thrown by buildSessionState when a persisted session's agentProfile
 * doesn't match the boot profile. The server layer catches this and maps
 * it to a 409 Conflict so the client can surface a clear message.
 */
export class ProfileMismatchError extends Error {
  readonly code = 'PROFILE_MISMATCH' as const
  constructor(
    public readonly sessionId: string,
    public readonly sessionProfile: string,
    public readonly bootProfile: string,
  ) {
    super(
      `Session ${sessionId} was created under agent profile "${sessionProfile}", ` +
        `but this server is running "${bootProfile}". Restart with ` +
        `AGENT_PROFILE=${sessionProfile} to open it.`,
    )
    this.name = 'ProfileMismatchError'
  }
}

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

  /**
   * Create a Session programmatically and immediately run its first turn
   * with `initialMessage` as the user input. The session row records
   * `spawnedBy` for audit, and a `session.spawned` event is emitted alongside
   * the normal `session.created`. The returned `handle.stream` is the same
   * shape as `handleUserMessage` — the caller drains it or hands it to a
   * background drainer.
   */
  async spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult> {
    const session = this.cfg.store.createSession({
      agentProfile: input.agentProfile ?? this.cfg.profile.id,
      title: input.title ?? null,
      spawnedBy: input.spawnedBy,
    })
    const ts = Date.now()
    await this.cfg.eventBus.emit({
      type: 'session.created',
      sessionId: session.id,
      agentProfile: session.agentProfile,
      ts,
    })
    await this.cfg.eventBus.emit({
      type: 'session.spawned',
      sessionId: session.id,
      agentProfile: session.agentProfile,
      spawnedBy: input.spawnedBy,
      ts,
    })
    if (input.allowedSkills && input.allowedSkills.length > 0) {
      // Pre-load skills so the first turn sees their tools. Failures don't
      // abort the spawn — they surface as `skill.load_failed` events and
      // the agent proceeds with whatever tools made it in.
      for (const skillName of input.allowedSkills) {
        try {
          await this.loadSkillIntoSession(session.id, skillName)
        } catch {
          // load_failed event already emitted; nothing more to do.
        }
      }
    }
    const handle = await this.handleUserMessage(session.id, input.initialMessage)
    return { session, handle }
  }

  async handleUserMessage(sessionId: string, userText: string): Promise<TurnHandle> {
    const state = await this.getSessionState(sessionId)
    // Fresh AbortController for this turn. If a prior turn is still in flight
    // (shouldn't happen — UI gates), abort it so the new one isn't racing.
    if (state.currentCancellation && !state.currentCancellation.signal.aborted) {
      state.currentCancellation.abort()
    }
    state.currentCancellation = new AbortController()

    // Resume from awaiting_input — the user's message is the answer the
    // agent was paused waiting for. The orchestrator owns this transition
    // because the storage layer is intentionally not auto-flipping state on
    // appendTurn ([[adr-0005]]).
    const persisted = this.cfg.store.getSession(sessionId)
    if (persisted?.state === 'awaiting_input') {
      this.cfg.store.setSessionState(sessionId, 'active')
    }

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

    // Compute passive recall once per user turn — its block survives all
    // tool-loop iterations triggered by this message. Disabled-by-default;
    // the helper returns null when the profile doesn't opt in or when no
    // sources match.
    let recall: PassiveRecallResult | null = null
    if (this.cfg.passiveRecall?.enabled) {
      try {
        recall = await buildPassiveRecall(userText, this.cfg.passiveRecall, {
          wiki: this.cfg.services.wiki,
          recall: this.cfg.services.recall,
          sessionId,
          eventBus: this.cfg.eventBus,
        })
      } catch {
        // Best-effort: a recall hiccup must not block the user's turn.
        recall = null
      }
    }

    return { stream: this.runToolLoop(state, recall) }
  }

  /**
   * Cancel an in-flight turn for the given session. Returns:
   *   - 'cancelled'     when the AbortController was successfully signalled
   *   - 'no_active_turn' when there's no turn in flight (idempotent no-op)
   *   - 'unknown_session' when the session isn't loaded
   *
   * Cancellation is cooperative: the loop checks signal between iterations,
   * providers receive it via ChatRequest.signal, and ToolContext exposes it
   * for handlers that opt in. Handlers that don't honour the signal are
   * bounded by the existing per-tool timeout (default 10s).
   */
  async cancelSession(
    sessionId: string,
  ): Promise<'cancelled' | 'no_active_turn' | 'unknown_session'> {
    const state = this.sessions.get(sessionId)
    if (!state) return 'unknown_session'
    const resolved = await state
    if (!resolved.currentCancellation || resolved.currentCancellation.signal.aborted) {
      return 'no_active_turn'
    }
    await this.cfg.eventBus.emit({
      type: 'turn.cancel_requested',
      sessionId,
      ts: Date.now(),
    })
    resolved.currentCancellation.abort()
    return 'cancelled'
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
      const reason = `permission denied: ${decision.reason}`
      await this.cfg.eventBus.emit({
        type: 'skill.load_failed',
        sessionId,
        name: skillName,
        reason,
        ts: Date.now(),
      })
      return { toolsRegistered: [], loaded: false, reason }
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
    // Path A multi-profile guard: this server boots with a single profile, so
    // refuse to open a session that was created under a different one. The
    // alternative (silently using boot-profile skills/permissions for a
    // session whose persisted agentProfile points at something else) leaks
    // budgets, deny-lists, and default skills across profiles. Path B —
    // resolving the session's profile at build time — comes when
    // multi-profile-per-server becomes a real product need.
    const session = this.cfg.store.getSession(sessionId)
    if (session && session.agentProfile !== this.cfg.profile.id) {
      throw new ProfileMismatchError(sessionId, session.agentProfile, this.cfg.profile.id)
    }

    // Compose a per-session HookRegistry: cross-cutting hooks from the
    // server config (audit-log, redaction) plus profile-derived hooks
    // (deny_tools). Each session gets a fresh registry so a profile's
    // deny list doesn't leak across sessions running other profiles.
    const baseHooks = this.cfg.hooks ?? new HookRegistry()
    const sessionHooks =
      this.cfg.profile.denyTools.length > 0
        ? baseHooks.compose({ pre: [buildDenyToolsHook(this.cfg.profile.denyTools)] })
        : baseHooks
    const registry = new ToolRegistry(sessionHooks, this.cfg.eventBus)
    const loadedSkills = new Set<string>()
    const permissions = new PermissionGate(this.cfg.profile)

    // Self-healing dispatch: when the model calls a tool whose skill hasn't
    // been loaded yet (common with smaller local models that ignore the
    // "call load_skill first" instruction), look up the owning skill and
    // load it on demand. Permissions still apply — a deny here surfaces as
    // the regular "Unknown tool" error to the model.
    registry.setUnknownToolResolver(async (toolId) => {
      for (const manifest of this.cfg.skillIndex.skills.values()) {
        if (loadedSkills.has(manifest.qualifiedName)) continue
        const declares = manifest.frontmatter.tools?.some((t) => t.id === toolId)
        if (!declares) continue
        const result = await this.loadSkillIntoRegistry({
          skillName: manifest.qualifiedName,
          registry,
          loadedSkills,
          permissions,
          sessionId,
        })
        if (result.loaded && registry.has(toolId)) return true
      }
      return false
    })

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

    registry.register(buildRequestUserInputTool())

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

    // Persist via the conversation store so expert budgets survive restarts.
    // Constructor rehydrates from `expert_spend_v1` for this session.
    const expertSpend = new ExpertSpendTracker({ sessionId, store: this.cfg.store })
    return {
      sessionId,
      registry,
      loadedSkills,
      permissions,
      systemMessage,
      expertSpend,
      currentCancellation: null,
    }
  }

  private async *runToolLoop(
    state: SessionState,
    recall: PassiveRecallResult | null,
  ): AsyncIterable<string> {
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let finalTurnId: string | null = null
    // Capture the AbortController for this turn once. handleUserMessage
    // creates a fresh one; we hold a stable reference here so a subsequent
    // turn that swaps state.currentCancellation doesn't accidentally make
    // *this* loop check the wrong signal.
    const signal = state.currentCancellation?.signal

    // Build history once before the loop. Subsequent iterations append the
    // newly-persisted assistant turn and synthesized tool results in-memory
    // so we don't re-query/re-tokenize the whole conversation each pass.
    const initialTurns = this.cfg.store.listTurns(state.sessionId)
    const toolCallsMap = this.cfg.store.listToolCallsBySession(state.sessionId)
    let history = turnsToMessages(initialTurns, toolCallsMap)

    // Passive recall is a one-shot context injection for this user turn:
    // prepended to history as a system message so ContextManager sees it as
    // part of the prefix (and includes it in compression candidates if the
    // conversation grows long). Lives for the duration of the tool loop.
    if (recall) {
      history = [recallToMessage(recall), ...history]
    }

    const emitCancelled = async (kind: 'soft' | 'hard'): Promise<void> => {
      await this.cfg.eventBus.emit({
        type: 'turn.cancelled',
        sessionId: state.sessionId,
        kind,
        ts: Date.now(),
      })
    }

    try {
      for (let iter = 0; iter < this.maxIterations; iter++) {
        // Soft-cancel check at every iteration boundary.
        if (signal?.aborted) {
          await emitCancelled('soft')
          return
        }
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

        const streamReq: import('../core/types.js').ChatRequest = {
          model: this.cfg.conversationModel.model,
          messages: prepared.messages,
          tools: state.registry.toolDefinitions(),
          toolChoice: 'auto',
          temperature: this.cfg.conversationModel.params.temperature ?? 0.4,
          maxTokens: this.cfg.conversationModel.params.maxTokens ?? 2048,
          topP: this.cfg.conversationModel.params.topP ?? 1,
        }
        if (signal) streamReq.signal = signal

        let streamAborted = false
        try {
          for await (const chunk of this.cfg.provider.stream(streamReq)) {
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
              // Provider post-processing: when Hermes-format <tool_call> XML
              // was promoted into native tool_calls, the provider hands back a
              // cleaned content string for persistence. The streamed deltas
              // already went to the UI verbatim (one-shot, can't un-emit), but
              // `collected` drives what we persist + replay to the model.
              if (chunk.replaceContent !== undefined) collected = chunk.replaceContent
              iterInput = chunk.inputTokens ?? 0
              iterOutput = chunk.outputTokens ?? 0
            }
          }
        } catch (err) {
          // AbortError from the provider's fetch (cancellation propagated
          // through the signal) is the expected hard-cancel path. Anything
          // else bubbles — provider/network errors should surface to the
          // outer error handling, not be silently swallowed by cancellation.
          if (isAbortError(err) || signal?.aborted) {
            streamAborted = true
          } else {
            throw err
          }
        }

        if (streamAborted) {
          await emitCancelled('hard')
          return
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
          permissions: state.permissions,
          expertSpend: state.expertSpend,
          ...(signal ? { signal } : {}),
        }
        for (const call of toolCalls) {
          // Soft-cancel check between tool calls — drop further work but
          // tool results already obtained on this iteration stay persisted.
          if (signal?.aborted) {
            await emitCancelled('soft')
            return
          }
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

        // If any tool transitioned the session to awaiting_input (the
        // request_user_input core tool, today; any future tool that does the
        // same would behave identically), end the turn. Don't schedule a
        // next iteration — the agent has explicitly asked to wait for the
        // user. The session resumes the next time handleUserMessage runs.
        const sessionAfterTools = this.cfg.store.getSession(state.sessionId)
        if (sessionAfterTools?.state === 'awaiting_input') {
          finalTurnId = assistantTurn.id
          return
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
      // Clear the cancellation controller — but only if it still belongs
      // to this turn. A subsequent handleUserMessage may have already
      // swapped in a fresh controller for the next turn; don't clobber it.
      if (
        state.currentCancellation &&
        state.currentCancellation.signal === signal
      ) {
        state.currentCancellation = null
      }
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function stringifyResult(result: unknown): string {
  try {
    return JSON.stringify(result)
  } catch {
    return JSON.stringify({ ok: false, error: 'unserialisable result' })
  }
}

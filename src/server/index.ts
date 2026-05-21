import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'

import { loadConfigFromEnv, type ServerConfig } from './config.js'
import { EventBus } from '../core/events.js'
import { loadBasePrompt } from '../profiles/base-prompt.js'
import { loadModelProfiles } from '../profiles/model-profile.js'
import { loadAgentProfile } from '../profiles/agent-profile.js'
import { ContextManager } from '../context/context-manager.js'
import { LMStudioProvider } from '../providers/lmstudio.js'
import { OpenRouterProvider } from '../providers/openrouter.js'
import { ProviderRegistry } from '../providers/registry.js'
import { HookRegistry } from '../skills/hooks.js'
import { buildAuditLogHook } from '../skills/audit-log-hook.js'
import { createDatabase } from '../storage/db.js'
import { createConversationStore, type ConversationStore } from '../storage/sqlite.js'
import { LocalFolderAdapter } from '../storage/local-folder.js'
import { WikiEngine } from '../memory/wiki/engine.js'
import { Orchestrator } from '../orchestrator/turn.js'
import { loadSkillIndex, type SkillIndex } from '../skills/loader.js'
import type { ModelProfile } from '../core/types.js'
import { buildCommandRegistry } from './commands/builders.js'
import type { CommandRegistry } from './commands/registry.js'
import type { CommandResult } from './commands/types.js'
import { buildHybridRecall } from '../search/hybrid.js'
import { EmbeddingIndexer } from '../search/embedding-indexer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SendMessageBody = z.object({ text: z.string().min(1) })
const CreateSessionBody = z.object({
  agentProfile: z.string().default('_base'),
  title: z.string().nullable().optional(),
})
const SessionIdParams = z.object({ id: z.string().uuid() })
const WsClientMessage = z.union([
  z.object({ op: z.literal('subscribe'), sessionId: z.string() }),
  z.object({ op: z.literal('unsubscribe'), sessionId: z.string() }),
])

// Transient events are NOT written to event_log. Bus subscribers can still
// see them; we just don't burn DB rows on high-cardinality flows.
const TRANSIENT_EVENT_TYPES = new Set([
  'message.assistant.delta',
  'embedding.indexed',
])

export interface AppDeps {
  config: ServerConfig
  bus: EventBus
  store: ConversationStore
  orchestrator: Orchestrator
  conversationModel: ModelProfile
  wiki: WikiEngine
  skillIndex: SkillIndex
  contextManager: ContextManager
  commands: CommandRegistry
}

const CommandRequestBody = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  /** Optional follow-up text — only used by skill slash_commands. */
  text: z.string().optional(),
})

const GlobalCommandBody = CommandRequestBody.extend({
  sessionId: z.string().uuid().optional(),
})

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(fastifyWebsocket)
  await app.register(fastifyStatic, {
    root: resolve(__dirname, '..', '..', deps.config.frontendDir),
    prefix: '/',
  })

  app.get('/api/health', async () => {
    await deps.wiki.whenReady()
    return {
      status: 'ok',
      model: deps.conversationModel.id,
      contextWindow: deps.conversationModel.contextWindow,
      storageRoot: deps.config.storageRoot,
      wikiPrefix: deps.config.wikiPrefix,
      agentProfile: deps.config.agentProfile,
    }
  })

  app.get('/api/sessions', async () => ({
    sessions: deps.store.listSessions(),
  }))

  app.post('/api/sessions', async (req, reply) => {
    const parsed = CreateSessionBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: 'Invalid body', details: parsed.error.flatten() }
    }
    const session = deps.store.createSession({
      agentProfile: parsed.data.agentProfile,
      title: parsed.data.title ?? null,
    })
    await deps.bus.emit({
      type: 'session.created',
      sessionId: session.id,
      agentProfile: session.agentProfile,
      ts: Date.now(),
    })
    return { session }
  })

  app.get('/api/sessions/:id', async (req, reply) => {
    const params = SessionIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid session id' }
    }
    const session = deps.store.getSession(params.data.id)
    if (!session) {
      reply.code(404)
      return { error: 'Not found' }
    }
    const turns = deps.store.listTurns(params.data.id)
    const toolCalls: Record<string, ReturnType<typeof deps.store.listToolCalls>> = {}
    for (const turn of turns) {
      if (turn.role !== 'assistant') continue
      const calls = deps.store.listToolCalls(turn.id)
      if (calls.length > 0) toolCalls[turn.id] = calls
    }
    return { session, turns, toolCalls }
  })

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const params = SessionIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid session id' }
    }
    const session = deps.store.getSession(params.data.id)
    if (!session) {
      reply.code(404)
      return { error: 'Session not found' }
    }
    const body = SendMessageBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'Invalid body', details: body.error.flatten() }
    }
    const handle = await deps.orchestrator.handleUserMessage(params.data.id, body.data.text)
    void drain(handle.stream)
    return { ok: true }
  })

  app.get('/api/commands', async () => {
    const built = deps.commands.list().map((c) => ({
      name: c.name,
      description: c.description,
      usage: c.usage,
      requiresSession: c.requiresSession,
      source: 'system' as const,
    }))
    const skillSlashes = [...deps.skillIndex.bySlashCommand.values()].map((m) => ({
      name: m.slashCommand as string,
      description: m.description,
      usage: `/${m.slashCommand} [text]`,
      requiresSession: true,
      source: 'skill' as const,
      skill: m.qualifiedName,
    }))
    return { commands: [...built, ...skillSlashes].sort((a, b) => a.name.localeCompare(b.name)) }
  })

  app.post('/api/sessions/:id/command', async (req, reply) => {
    const params = SessionIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid session id' }
    }
    const body = CommandRequestBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'Invalid body', details: body.error.flatten() }
    }
    const result = await dispatchCommand(deps, body.data, params.data.id)
    return { result }
  })

  app.post('/api/command', async (req, reply) => {
    const body = GlobalCommandBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'Invalid body', details: body.error.flatten() }
    }
    const result = await dispatchCommand(deps, body.data, body.data.sessionId ?? null)
    return { result }
  })

  app.register(async function (instance) {
    instance.get('/ws', { websocket: true }, (socket) => {
      const subscriptions = new Set<string>()
      const off = deps.bus.onAny((e) => {
        if (subscriptions.size === 0) return
        if (!('sessionId' in e)) return
        if (e.sessionId === null || !subscriptions.has(e.sessionId)) return
        try {
          socket.send(JSON.stringify(e))
        } catch {
          /* socket closed mid-send */
        }
      })

      socket.on('message', (raw: Buffer | string) => {
        try {
          const parsed = WsClientMessage.safeParse(JSON.parse(String(raw)))
          if (!parsed.success) return
          if (parsed.data.op === 'subscribe') subscriptions.add(parsed.data.sessionId)
          else subscriptions.delete(parsed.data.sessionId)
        } catch {
          /* invalid json; ignore */
        }
      })

      const cleanup = (): void => {
        off()
        subscriptions.clear()
      }
      socket.on('close', cleanup)
      socket.on('error', cleanup)
    })
  })

  return app
}

async function drain(stream: AsyncIterable<string>): Promise<void> {
  // The orchestrator's stream emits deltas as observer events; iterating
  // here only drives its generator past completion so the finally-block
  // persists the assistant turn.
  for await (const _ of stream) void _
}

/**
 * Resolve a command name to either a system command or a skill slash_command.
 * Skill commands LOAD the skill and forward any trailing text as a user
 * message (matching the PRD's "skill commands" semantics).
 */
async function dispatchCommand(
  deps: AppDeps,
  body: { name: string; args?: Record<string, unknown>; text?: string },
  sessionId: string | null,
): Promise<CommandResult> {
  const args = body.args ?? {}
  if (deps.commands.has(body.name)) {
    return deps.commands.dispatch(body.name, args, {
      sessionId,
      store: deps.store,
      skillIndex: deps.skillIndex,
      orchestrator: deps.orchestrator,
      contextManager: deps.contextManager,
      config: deps.config,
    })
  }
  const manifest = deps.skillIndex.bySlashCommand.get(body.name)
  if (!manifest) {
    return { kind: 'error', message: `Unknown command: /${body.name}`, recoverable: true }
  }
  if (!sessionId) {
    return {
      kind: 'error',
      message: `/${body.name} requires an active session`,
      recoverable: true,
    }
  }
  const loaded = await deps.orchestrator.loadSkillIntoSession(sessionId, manifest.qualifiedName)
  if (!loaded.alreadyLoaded && !loaded.loaded) {
    return {
      kind: 'error',
      message: `Could not load ${manifest.qualifiedName}: ${loaded.reason}`,
      recoverable: loaded.reason.startsWith('permission denied'),
    }
  }
  const forwarded = !!body.text && body.text.trim().length > 0
  if (forwarded) {
    const handle = await deps.orchestrator.handleUserMessage(sessionId, body.text as string)
    void drain(handle.stream)
  }
  return {
    kind: 'skill_invoked',
    skill: manifest.qualifiedName,
    forwarded,
    alreadyLoaded: loaded.alreadyLoaded,
  }
}

export async function bootstrap(): Promise<void> {
  const config = loadConfigFromEnv()
  const bus = new EventBus()

  if (config.logEvents) {
    bus.onAny((e) => {
      // eslint-disable-next-line no-console
      console.log(`[event] ${e.type}`)
    })
  }

  const db = createDatabase({ path: config.dbPath })
  const store = createConversationStore(db)
  const storage = new LocalFolderAdapter({ root: config.storageRoot })
  const wiki = new WikiEngine({ storage, db, prefix: config.wikiPrefix })

  bus.onAny((e) => {
    if (TRANSIENT_EVENT_TYPES.has(e.type)) return
    if (!('sessionId' in e)) return
    store.logEvent({
      sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
      type: e.type,
      payload: e,
    })
  })

  const [basePrompt, modelProfiles, agentProfile, skillIndex] = await Promise.all([
    loadBasePrompt(config.basePromptPath),
    loadModelProfiles(config.modelProfilesDir),
    loadAgentProfile(config.agentProfilesDir, config.agentProfile),
    loadSkillIndex({ root: config.skillsDir }),
  ])

  const conversationModelId =
    agentProfile.defaultModel === 'local-fast' || agentProfile.defaultModel === ''
      ? config.defaultModelProfile
      : agentProfile.defaultModel
  const compressorModelId =
    agentProfile.compressorModel ?? config.compressorModelProfile

  const conversationModel = modelProfiles.get(conversationModelId)
  if (!conversationModel) {
    throw new Error(
      `Conversation Model Profile not found: ${conversationModelId} (referenced by agent profile ${agentProfile.id})`,
    )
  }
  const compressorModel = modelProfiles.get(compressorModelId)
  if (!compressorModel) {
    throw new Error(`Compressor Model Profile not found: ${compressorModelId}`)
  }

  // Build a provider registry — LMStudio is always registered; OpenRouter is
  // registered only when an API key is configured. The orchestrator + recall
  // + indexer continue to use the local provider directly because the
  // conversation/compressor/embedding models are local-fast / local-compressor /
  // local-embed. consult_expert looks up providers via the registry.
  const providers = new ProviderRegistry()
  const lmstudio = new LMStudioProvider({ baseUrl: config.lmStudioBaseUrl })
  providers.register(lmstudio)
  if (config.openRouterApiKey) {
    providers.register(
      new OpenRouterProvider({
        baseUrl: config.openRouterBaseUrl,
        apiKey: config.openRouterApiKey,
        appTitle: config.openRouterAppTitle,
        ...(config.openRouterHttpReferer && { httpReferer: config.openRouterHttpReferer }),
      }),
    )
  }
  const conversationProvider = providers.get(conversationModel.provider)
  const compressorProvider = providers.get(compressorModel.provider)

  // Embedding profile is optional — if it's not configured we still run, but
  // search_history degrades to FTS5-only and no background indexing fires.
  const embeddingModel = modelProfiles.get(config.embeddingModelProfile)
  const embeddingProvider = embeddingModel ? providers.get(embeddingModel.provider) : null
  const recall = buildHybridRecall({
    store,
    provider: embeddingProvider ?? conversationProvider,
    embeddingModel: embeddingModel?.model ?? '',
    eventBus: bus,
  })
  const indexer = embeddingModel && embeddingProvider
    ? new EmbeddingIndexer({
        store,
        provider: embeddingProvider,
        model: embeddingModel.model,
        eventBus: bus,
      })
    : null
  if (indexer) {
    // Nudge the indexer whenever a user or assistant turn is recorded.
    bus.on('message.user.received', () => indexer.nudge())
    bus.on('message.assistant.completed', () => indexer.nudge())
    indexer.start()
  }

  const contextManager = new ContextManager({
    compressorProvider,
    compressorModel: compressorModel.model,
    contextWindow: conversationModel.contextWindow,
    eventBus: bus,
  })

  // The agent profile may also reference its own system_prompt_file, layered
  // on top of the base prompt. Compose at orchestrator level so per-session
  // state can also see it; here we just thread basePrompt through and let
  // the orchestrator apply the agent profile system prompt as part of
  // composeSystemMessage when we extend it (deferred for M3).
  let effectiveBasePrompt = basePrompt
  if (agentProfile.systemPromptFile) {
    try {
      const extra = (await readFile(agentProfile.systemPromptFile, 'utf-8')).trim()
      if (extra) effectiveBasePrompt = `${basePrompt}\n\n${extra}`
    } catch {
      // Profile names a system_prompt_file that doesn't exist; tolerate.
    }
  }

  // Cross-cutting tool hooks (redaction, audit, deny rules). The example
  // audit-log hook is opt-in via AUDIT_LOG_PATH — when set, every tool call
  // appends a JSONL record to that file so operators have a tamper-evident
  // record outside the SQLite event_log.
  const hookRegistry = new HookRegistry()
  if (config.auditLogPath) {
    hookRegistry.addPostHook(buildAuditLogHook({ path: config.auditLogPath }))
    // eslint-disable-next-line no-console
    console.log(`  Tool audit log: ${config.auditLogPath}`)
  }

  const orchestrator = new Orchestrator({
    store,
    contextManager,
    provider: conversationProvider,
    conversationModel,
    hooks: hookRegistry,
    eventBus: bus,
    skillIndex,
    profile: agentProfile,
    basePrompt: effectiveBasePrompt,
    services: {
      storage,
      wiki,
      conversationStore: store,
      recall,
      providers,
      modelProfiles,
      eventBus: bus,
    },
  })

  const commands = buildCommandRegistry(skillIndex)

  const app = await buildApp({
    config,
    bus,
    store,
    orchestrator,
    conversationModel,
    wiki,
    skillIndex,
    contextManager,
    commands,
  })

  await wiki.whenReady()
  await app.listen({ port: config.port, host: config.host })
  // Show a friendly URL — 0.0.0.0 is a bind address, not a dial address.
  const displayHost = config.host === '0.0.0.0' ? '<lan-ip>' : config.host
  // eslint-disable-next-line no-console
  console.log(`AgentOne listening on http://${displayHost}:${config.port}`)
  if (config.host === '0.0.0.0') {
    // eslint-disable-next-line no-console
    console.log('  WARNING: bound to 0.0.0.0 — reachable by anyone on this network. No auth is enforced.')
  }
  // eslint-disable-next-line no-console
  console.log(
    `  profile=${agentProfile.id}  model=${conversationModel.id}  skills=${skillIndex.skills.size}`,
  )
}

const entryUrl = pathToFileURL(process.argv[1] ?? '').href
if (import.meta.url === entryUrl) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Bootstrap failed:', err)
    process.exit(1)
  })
}

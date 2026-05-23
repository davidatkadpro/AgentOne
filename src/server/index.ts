import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { readFile, readdir, stat } from 'node:fs/promises'

import { loadConfigFromEnv, type ServerConfig } from './config.js'
import { EventBus } from '../core/events.js'
import { loadBasePrompt } from '../profiles/base-prompt.js'
import { loadModelProfiles } from '../profiles/model-profile.js'
import { loadAgentProfile } from '../profiles/agent-profile.js'
import { ContextManager } from '../context/context-manager.js'
import { AutoDistillScheduler } from '../orchestrator/auto-distill.js'
import { AutoTitler } from '../orchestrator/auto-titler.js'
import { loadEventHooks } from '../hooks/event-hook-runner.js'
import { listAvailableProfiles, listDrafts } from './profiles-and-drafts.js'
import { DocumentIndex } from '../memory/documents/doc-index.js'
import { extractByFormat } from '../../skills/system/documents/tools/extractors.js'
import { LMStudioProvider } from '../providers/lmstudio.js'
import { OpenRouterProvider } from '../providers/openrouter.js'
import { ProviderRegistry } from '../providers/registry.js'
import type { Provider } from '../providers/base.js'
import { HookRegistry } from '../skills/hooks.js'
import { buildAuditLogHook } from '../skills/audit-log-hook.js'
import { createDatabase, type Db } from '../storage/db.js'
import { createConversationStore, type ConversationStore } from '../storage/sqlite.js'
import { createNotifications } from '../modules/notifications.js'
import { createAuditLog } from '../modules/audit-log.js'
import { bootModules, type ModuleRegistry } from '../modules/registry.js'
import { createProjectsService } from '../../modules/projects/src/service.js'
import { registerProjectsRoutes } from '../../modules/projects/src/routes.js'
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
const RenameSessionBody = z.object({ title: z.string().min(1).max(200) })
const CreateSessionBody = z.object({
  /** Optional. When omitted, the server uses its boot agentProfile. When
   *  present and != boot profile, /api/sessions returns 409 (Path A
   *  single-profile-per-server). */
  agentProfile: z.string().optional(),
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
  /** Compressor model + provider (per-profile). Same model the
   *  ContextManager uses for summarisation; reused by /distill. */
  compressorProvider: Provider
  compressorModel: string
  /** Raw SQLite handle. Used by /backup to drive the online-backup API. */
  db: Db
  /** Registry of v2 Modules booted from `modules/`. Routes that operate on
   *  Module-owned state look up their service via this. */
  modules: ModuleRegistry
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

  app.get('/api/profiles', async () => {
    const profiles = await listAvailableProfiles(deps.config.agentProfilesDir)
    return { profiles, current: deps.config.agentProfile }
  })

  app.get('/api/drafts', async () => {
    const drafts = await listDrafts(deps.config.storageRoot)
    return { drafts }
  })

  app.post('/api/sessions', async (req, reply) => {
    const parsed = CreateSessionBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: 'Invalid body', details: parsed.error.flatten() }
    }
    // Path A: single-profile-per-server. An explicit mismatch is rejected;
    // an omitted profile inherits the boot profile so callers don't have to
    // know it. The orchestrator enforces the same invariant at session-open
    // time as a defence-in-depth for sessions created by older clients.
    const requested = parsed.data.agentProfile
    if (requested !== undefined && requested !== deps.config.agentProfile) {
      reply.code(409)
      return {
        error: 'PROFILE_MISMATCH',
        message:
          `Server is running agent profile "${deps.config.agentProfile}" — ` +
          `cannot create a session under "${requested}". ` +
          `Restart with AGENT_PROFILE=${requested}, or omit agentProfile to use the boot profile.`,
      }
    }
    const session = deps.store.createSession({
      agentProfile: requested ?? deps.config.agentProfile,
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
    const mismatch = profileMismatchResponse(session, deps.config.agentProfile)
    if (mismatch) {
      reply.code(409)
      return mismatch
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

  app.post('/api/sessions/:id/cancel', async (req, reply) => {
    const params = SessionIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid session id' }
    }
    const outcome = await deps.orchestrator.cancelSession(params.data.id)
    return { outcome }
  })

  app.patch('/api/sessions/:id', async (req, reply) => {
    const params = SessionIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid session id' }
    }
    const body = RenameSessionBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'Invalid body', details: body.error.flatten() }
    }
    const session = deps.store.getSession(params.data.id)
    if (!session) {
      reply.code(404)
      return { error: 'Session not found' }
    }
    deps.store.setSessionTitle(params.data.id, body.data.title)
    await deps.bus.emit({
      type: 'session.titled',
      sessionId: params.data.id,
      title: body.data.title,
      ts: Date.now(),
    })
    return { session: { ...session, title: body.data.title } }
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
    const session = deps.store.getSession(params.data.id)
    if (session) {
      const mismatch = profileMismatchResponse(session, deps.config.agentProfile)
      if (mismatch) {
        reply.code(409)
        return mismatch
      }
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
    instance.get('/ws', { websocket: true }, (socket, req) => {
      const subscriptions = new Set<string>()

      // Subscribe at handshake time via ?sessionId=xxx (repeatable) so a
      // reconnecting client doesn't race against in-flight events. The
      // legacy {op:'subscribe'} message path below still works.
      const query = req.query as Record<string, unknown> | undefined
      if (query) {
        const raw = query.sessionId
        const ids = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
        for (const id of ids) if (typeof id === 'string' && id) subscriptions.add(id)
      }

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

  // Module-owned routes. Each Module that wants HTTP exposure registers under
  // /api/v1/<module>/...; routes look up their service via the registry.
  const projectsHandle = deps.modules.get('projects')
  if (projectsHandle?.status === 'active' && projectsHandle.service) {
    const projectsService = projectsHandle.service as Parameters<
      typeof registerProjectsRoutes
    >[1]['service']
    await registerProjectsRoutes(app, { service: projectsService })
  }

  return app
}

/**
 * Lightweight scan of `modules/` to collect skill roots. Doesn't validate
 * MODULE.md beyond existence — the bootModules pass later does the full
 * manifest check. Returns the list of `{ module, root }` entries to hand
 * to loadSkillIndex; modules without a `skills/` subdir are skipped.
 */
async function discoverModuleSkillRoots(
  modulesRoot: string,
): Promise<Array<{ module: string; root: string }>> {
  const out: Array<{ module: string; root: string }> = []
  let entries
  try {
    entries = await readdir(modulesRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const moduleDir = join(modulesRoot, ent.name)
    const manifestPath = join(moduleDir, 'MODULE.md')
    const skillsDir = join(moduleDir, 'skills')
    try {
      await stat(manifestPath)
    } catch {
      continue
    }
    try {
      const s = await stat(skillsDir)
      if (s.isDirectory()) {
        out.push({ module: ent.name, root: skillsDir })
      }
    } catch {
      // No skills dir — module exists but contributes no Skills.
    }
  }
  return out
}

async function drain(stream: AsyncIterable<string>): Promise<void> {
  // The orchestrator's stream emits deltas as observer events; iterating
  // here only drives its generator past completion so the finally-block
  // persists the assistant turn.
  for await (const _ of stream) void _
}

function profileMismatchResponse(
  session: { agentProfile: string },
  bootProfile: string,
): { error: 'PROFILE_MISMATCH'; message: string } | null {
  if (session.agentProfile === bootProfile) return null
  return {
    error: 'PROFILE_MISMATCH',
    message:
      `Session was created under agent profile "${session.agentProfile}", ` +
      `but this server is running "${bootProfile}". ` +
      `Restart with AGENT_PROFILE=${session.agentProfile} to open it.`,
  }
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
      wiki: deps.wiki,
      compressorProvider: deps.compressorProvider,
      compressorModel: deps.compressorModel,
      db: deps.db,
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
  const notifications = createNotifications(db)
  const audit = createAuditLog(db)
  const storage = new LocalFolderAdapter({ root: config.storageRoot })
  const wiki = new WikiEngine({ storage, db, prefix: config.wikiPrefix })
  const documents = new DocumentIndex({
    storage,
    db,
    extract: async (path, content) => {
      try {
        const extracted = await extractByFormat(path, content)
        return extracted ? extracted.text : null
      } catch {
        // Extraction failure on one file shouldn't break the index pass.
        return null
      }
    },
  })

  bus.onAny((e) => {
    if (TRANSIENT_EVENT_TYPES.has(e.type)) return
    if (!('sessionId' in e)) return
    store.logEvent({
      sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
      type: e.type,
      payload: e,
    })
  })

  // Discover Module-scoped Skills alongside the top-level `skills/` tree.
  // We just need the *paths* here — actual Module service instantiation
  // happens later via bootModules. Scanning modules/<name>/skills/ keeps
  // skill discovery cheap and parallel to the existing categories scan.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const modulesRoot = join(repoRoot, 'modules')
  const moduleSkillRoots = await discoverModuleSkillRoots(modulesRoot)

  const [basePrompt, modelProfiles, agentProfile, skillIndex] = await Promise.all([
    loadBasePrompt(config.basePromptPath),
    loadModelProfiles(config.modelProfilesDir),
    loadAgentProfile(config.agentProfilesDir, config.agentProfile),
    loadSkillIndex({ root: config.skillsDir, moduleSkillRoots }),
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

  // Boot v2 Modules from `modules/` at the repo root. Each Module's
  // `MODULE.md` declares deps + version; `schema/*.sql` files are run via the
  // shared migration runner; the matching factory below produces the service
  // instance the ModuleRegistry exposes. Modules without an entry in the
  // factories map are discovered but ship no service (manifest + tables only).
  const modules = await bootModules({
    db,
    rootDir: modulesRoot,
    eventBus: bus,
    audit,
    storage,
    factories: {
      projects: (ctx) =>
        createProjectsService({
          db: ctx.db,
          eventBus: ctx.eventBus,
          audit: ctx.audit,
          storage: ctx.storage,
        }),
    },
  })
  for (const handle of modules.list()) {
    if (handle.status === 'degraded') {
      // eslint-disable-next-line no-console
      console.warn(`[modules] ${handle.name} degraded: ${handle.degradedReason}`)
    }
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
    passiveRecall: agentProfile.passiveRecall,
    services: {
      storage,
      wiki,
      documents,
      conversationStore: store,
      recall,
      providers,
      modelProfiles,
      eventBus: bus,
      notifications,
      modules,
    },
  })

  // Auto-titler: always on. Generates short titles for sessions that hit
  // the trigger threshold without one. Failures are swallowed inside the
  // titler — never blocks the chat.
  const autoTitler = new AutoTitler(
    {},
    {
      store,
      titlerProvider: compressorProvider,
      titlerModel: compressorModel.model,
      eventBus: bus,
    },
  )
  autoTitler.start()

  // Event hooks: optional YAML-declared subscribers run on every matching
  // bus event. Used for tee-to-file logging, custom alerting, etc. Failures
  // inside a handler are isolated — never propagate back into the bus.
  if (config.eventHooksPath) {
    try {
      const runner = await loadEventHooks(config.eventHooksPath)
      if (runner) {
        runner.start(bus)
        // eslint-disable-next-line no-console
        console.log(`  Event hooks: ${runner.hookCount()} loaded from ${config.eventHooksPath}`)
      } else {
        // eslint-disable-next-line no-console
        console.log(`  Event hooks: file not found at ${config.eventHooksPath} (skipped)`)
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`  Event hooks: failed to load — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const commands = buildCommandRegistry(skillIndex)

  // Start the auto-distill scheduler if the active profile opts in.
  // The scheduler subscribes to event-bus activity, primes its state from
  // the existing session list, and runs periodic scans in the background.
  let autoDistillScheduler: AutoDistillScheduler | null = null
  if (agentProfile.autoDistill.enabled) {
    autoDistillScheduler = new AutoDistillScheduler(
      { ...agentProfile.autoDistill, storageRoot: config.storageRoot },
      {
        store,
        wiki,
        compressorProvider,
        compressorModel: compressorModel.model,
        eventBus: bus,
      },
    )
    autoDistillScheduler.start()
    // eslint-disable-next-line no-console
    console.log(
      `  Auto-distill: enabled (idle ${agentProfile.autoDistill.idleMinutes}min, scan every ${agentProfile.autoDistill.scanIntervalMinutes}min)`,
    )
  }

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
    compressorProvider,
    compressorModel: compressorModel.model,
    db,
    modules,
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

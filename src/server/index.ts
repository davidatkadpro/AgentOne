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
import { createDatabase } from '../storage/db.js'
import { createConversationStore, type ConversationStore } from '../storage/sqlite.js'
import { LocalFolderAdapter } from '../storage/local-folder.js'
import { WikiEngine } from '../memory/wiki/engine.js'
import { Orchestrator } from '../orchestrator/turn.js'
import { loadSkillIndex } from '../skills/loader.js'
import type { ModelProfile } from '../core/types.js'

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

const TRANSIENT_EVENT_TYPES = new Set(['message.assistant.delta'])

export interface AppDeps {
  config: ServerConfig
  bus: EventBus
  store: ConversationStore
  orchestrator: Orchestrator
  conversationModel: ModelProfile
  wiki: WikiEngine
}

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

  app.register(async function (instance) {
    instance.get('/ws', { websocket: true }, (socket) => {
      const subscriptions = new Set<string>()
      const off = deps.bus.onAny((e) => {
        if (subscriptions.size === 0) return
        if (!('sessionId' in e) || !subscriptions.has(e.sessionId)) return
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

  const provider = new LMStudioProvider({ baseUrl: config.lmStudioBaseUrl })

  const contextManager = new ContextManager({
    compressorProvider: provider,
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

  const orchestrator = new Orchestrator({
    store,
    contextManager,
    provider,
    conversationModel,
    eventBus: bus,
    skillIndex,
    profile: agentProfile,
    basePrompt: effectiveBasePrompt,
    services: { storage, wiki, conversationStore: store },
  })

  const app = await buildApp({
    config,
    bus,
    store,
    orchestrator,
    conversationModel,
    wiki,
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

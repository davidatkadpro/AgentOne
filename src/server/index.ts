import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'

import { loadConfigFromEnv, type ServerConfig } from './config.js'
import { EventBus } from '../core/events.js'
import { loadBasePrompt } from '../profiles/base-prompt.js'
import { loadModelProfiles } from '../profiles/model-profile.js'
import { composeSystemMessage } from '../context/prompt-composer.js'
import { ContextManager } from '../context/context-manager.js'
import { LMStudioProvider } from '../providers/lmstudio.js'
import { createDatabase } from '../storage/db.js'
import { createConversationStore, type ConversationStore } from '../storage/sqlite.js'
import { LocalFolderAdapter } from '../storage/local-folder.js'
import { WikiEngine } from '../memory/wiki/engine.js'
import { Orchestrator } from '../orchestrator/turn.js'
import type { ModelProfile } from '../core/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SendMessageBody = z.object({ text: z.string().min(1) })
const CreateSessionBody = z.object({
  agentProfile: z.string().default('default'),
  title: z.string().nullable().optional(),
})
const SessionIdParams = z.object({ id: z.string().uuid() })
const WsClientMessage = z.union([
  z.object({ op: z.literal('subscribe'), sessionId: z.string() }),
  z.object({ op: z.literal('unsubscribe'), sessionId: z.string() }),
])

// Events excluded from the durable event log — these are high-frequency
// and reconstructable from the persisted assistant turn.
const TRANSIENT_EVENT_TYPES = new Set(['message.assistant.delta'])

export interface AppDeps {
  config: ServerConfig
  bus: EventBus
  store: ConversationStore
  contextManager: ContextManager
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
    return { session, turns: deps.store.listTurns(params.data.id) }
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
    // Drive the generator so its finally-block persists the assistant turn and
    // emits completion. Deltas already reach the UI via WS observers.
    void drain(handle.stream)
    return { ok: true, assistantTurnId: handle.assistantTurnId }
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
  // The orchestrator's stream emits deltas as observer events; the only
  // reason to iterate here is to drive its generator past completion so the
  // finally-block persists the assistant turn.
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

  const [basePrompt, modelProfiles] = await Promise.all([
    loadBasePrompt(config.basePromptPath),
    loadModelProfiles(config.modelProfilesDir),
  ])

  const conversationModel = modelProfiles.get(config.defaultModelProfile)
  if (!conversationModel) {
    throw new Error(`Default model profile not found: ${config.defaultModelProfile}`)
  }
  const compressorModel = modelProfiles.get(config.compressorModelProfile)
  if (!compressorModel) {
    throw new Error(`Compressor model profile not found: ${config.compressorModelProfile}`)
  }

  const provider = new LMStudioProvider({ baseUrl: config.lmStudioBaseUrl })

  const contextManager = new ContextManager({
    compressorProvider: provider,
    compressorModel: compressorModel.model,
    contextWindow: conversationModel.contextWindow,
    eventBus: bus,
  })

  const systemMessage = composeSystemMessage({ basePrompt })

  const orchestrator = new Orchestrator({
    store,
    contextManager,
    provider,
    model: conversationModel,
    eventBus: bus,
    systemMessage,
  })

  const app = await buildApp({
    config,
    bus,
    store,
    contextManager,
    orchestrator,
    conversationModel,
    wiki,
  })

  await wiki.whenReady()
  await app.listen({ port: config.port, host: '127.0.0.1' })
  // eslint-disable-next-line no-console
  console.log(`AgentOne listening on http://127.0.0.1:${config.port}`)
}

const entryUrl = pathToFileURL(process.argv[1] ?? '').href
if (import.meta.url === entryUrl) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Bootstrap failed:', err)
    process.exit(1)
  })
}

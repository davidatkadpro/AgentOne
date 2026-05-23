import { describe, it, expect, afterEach } from 'vitest'
import { Orchestrator } from '@/orchestrator/turn.js'
import { ContextManager } from '@/context/context-manager.js'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { createNotifications, type Notifications } from '@/modules/notifications.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import type { ChatChunk, ChatRequest, ModelProfile } from '@/core/types.js'
import type { Provider } from '@/providers/base.js'
import type { SkillIndex } from '@/skills/loader.js'
import type { ResolvedAgentProfile } from '@/profiles/agent-profile.js'
import { fakeServices } from './fakes.js'

class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  readonly capabilities = { streaming: true, tools: true }
  readonly calls: ChatRequest[] = []
  constructor(private readonly scripts: ChatChunk[][]) {}
  async chat(): Promise<never> {
    throw new Error('unused')
  }
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const idx = this.calls.length
    this.calls.push(req)
    const script = this.scripts[idx]
    if (!script) throw new Error(`No script for call ${idx}`)
    for (const chunk of script) yield chunk
  }
}

const modelProfile: ModelProfile = {
  id: 'fake',
  provider: 'lmstudio',
  model: 'fake-model',
  role: 'general',
  contextWindow: 32_768,
  params: {},
}

const agentProfile: ResolvedAgentProfile = {
  id: 'ops',
  systemPromptFile: null,
  defaultModel: 'fake',
  compressorModel: null,
  defaultSkills: [],
  permissions: {
    skills: { allow: [], deny: [] },
    experts: { allow: [], budgetPerCallUsd: null, budgetPerSessionUsd: null },
  },
  passiveRecall: { enabled: false, wikiHits: 2, historyHits: 2, maxCharsPerHit: 240 },
  autoDistill: { enabled: false, idleMinutes: 30, scanIntervalMinutes: 5, draftsMaxAgeDays: 0 },
  denyTools: [],
  sourceFile: '',
}

const emptySkillIndex: SkillIndex = {
  skills: new Map(),
  categories: new Map(),
  bySlashCommand: new Map(),
}

interface Harness {
  db: Db
  store: ConversationStore
  notifications: Notifications
  bus: EventBus
  events: AgentEvent[]
  provider: ScriptedProvider
  orchestrator: Orchestrator
}

function newHarness(scripts: ChatChunk[][]): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const store = createConversationStore(db)
  const notifications = createNotifications(db)
  const bus = new EventBus()
  const events: AgentEvent[] = []
  bus.onAny((e) => {
    events.push(e)
  })
  const provider = new ScriptedProvider(scripts)
  const contextManager = new ContextManager({
    compressorProvider: {
      id: 'comp',
      capabilities: { streaming: false, tools: false },
      async chat() {
        return { content: '', inputTokens: 0, outputTokens: 0, finishReason: 'stop' }
      },
      async *stream() {
        throw new Error('unused')
      },
    },
    compressorModel: 'comp',
    contextWindow: 32_768,
    eventBus: bus,
  })
  const orchestrator = new Orchestrator({
    store,
    contextManager,
    provider,
    conversationModel: modelProfile,
    eventBus: bus,
    skillIndex: emptySkillIndex,
    profile: agentProfile,
    basePrompt: 'You are an ops agent.',
    services: fakeServices({ conversationStore: store, eventBus: bus, notifications }),
  })
  return { db, store, notifications, bus, events, provider, orchestrator }
}

async function drain(stream: AsyncIterable<string>): Promise<void> {
  for await (const _ of stream) {
    // discard
  }
}

describe('Orchestrator.spawnSession', () => {
  let h: Harness
  afterEach(() => {
    h?.db.close()
  })

  it('creates a session with spawnedBy persisted and runs the initial turn', async () => {
    h = newHarness([
      [
        { delta: 'I filed the email.', done: false },
        {
          delta: '',
          done: true,
          inputTokens: 4,
          outputTokens: 4,
          finishReason: 'stop',
        },
      ],
    ])
    const result = await h.orchestrator.spawnSession({
      spawnedBy: 'modules/email',
      initialMessage: 'File email msg-100 into project 24001.',
    })
    await drain(result.handle.stream)

    expect(result.session.id).toBeTruthy()
    expect(result.session.spawnedBy).toBe('modules/email')
    expect(result.session.agentProfile).toBe('ops')
    expect(h.provider.calls).toHaveLength(1)
    // The initial message should be in persisted history.
    const turns = h.store.listTurns(result.session.id)
    expect(turns.find((t) => t.role === 'user')?.content).toContain('File email msg-100')
  })

  it('emits session.created and session.spawned events with spawnedBy', async () => {
    h = newHarness([
      [
        {
          delta: '',
          done: true,
          inputTokens: 1,
          outputTokens: 1,
          finishReason: 'stop',
        },
      ],
    ])
    const result = await h.orchestrator.spawnSession({
      spawnedBy: 'http://api/email/actions',
      initialMessage: 'do the thing',
    })
    await drain(result.handle.stream)

    const created = h.events.find((e) => e.type === 'session.created')
    const spawned = h.events.find((e) => e.type === 'session.spawned')
    expect(created).toBeDefined()
    expect(spawned).toBeDefined()
    expect(spawned).toMatchObject({
      type: 'session.spawned',
      sessionId: result.session.id,
      spawnedBy: 'http://api/email/actions',
      agentProfile: 'ops',
    })
  })

  it('accepts an optional title and sets it on the session', async () => {
    h = newHarness([
      [
        {
          delta: '',
          done: true,
          inputTokens: 1,
          outputTokens: 1,
          finishReason: 'stop',
        },
      ],
    ])
    const result = await h.orchestrator.spawnSession({
      spawnedBy: 'modules/email',
      initialMessage: 'do',
      title: 'File email msg-100',
    })
    await drain(result.handle.stream)
    expect(result.session.title).toBe('File email msg-100')
  })
})

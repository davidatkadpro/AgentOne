import { describe, it, expect, afterEach } from 'vitest'
import { Orchestrator } from '@/orchestrator/turn.js'
import { ContextManager } from '@/context/context-manager.js'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { createNotifications, type Notifications } from '@/modules/notifications.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import type { ChatChunk, ChatRequest, ModelProfile, ToolCallSpec } from '@/core/types.js'
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
  id: 'test',
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
  autoTitle: { enabled: true, triggerAfter: 3 },
  denyTools: [],
  sourceFile: '',
}

const emptySkillIndex: SkillIndex = {
  skills: new Map(),
  categories: new Map(),
  bySlashCommand: new Map(),
}

function requestInputToolCall(question = 'Which project?'): ToolCallSpec {
  return {
    id: 'call-1',
    type: 'function',
    function: {
      name: 'request_user_input',
      arguments: JSON.stringify({ question }),
    },
  }
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
    basePrompt: 'You are a test agent.',
    services: fakeServices({ conversationStore: store, eventBus: bus, notifications }),
  })
  return { db, store, notifications, bus, events, provider, orchestrator }
}

async function drain(stream: AsyncIterable<string>): Promise<void> {
  for await (const _chunk of stream) {
    // discard
  }
}

describe('Orchestrator — request_user_input ends the turn', () => {
  let h: Harness
  afterEach(() => {
    h?.db.close()
  })

  it('does not run a second model iteration after the tool call', async () => {
    h = newHarness([
      [
        {
          delta: '',
          done: true,
          inputTokens: 5,
          outputTokens: 5,
          finishReason: 'tool_calls',
          toolCalls: [requestInputToolCall()],
        },
      ],
      // A second script — if the orchestrator runs another iteration, this
      // would be used. Its presence makes a missing-stop bug observable as
      // "provider was called twice".
      [
        {
          delta: 'Oops still running',
          done: false,
        },
        {
          delta: '',
          done: true,
          inputTokens: 1,
          outputTokens: 4,
          finishReason: 'stop',
        },
      ],
    ])
    const session = h.store.createSession({ agentProfile: 'test' })
    const handle = await h.orchestrator.handleUserMessage(session.id, 'hi')
    await drain(handle.stream)

    expect(h.provider.calls).toHaveLength(1)
    expect(h.store.getSession(session.id)?.state).toBe('awaiting_input')
    expect(h.notifications.list({ status: 'unread' })).toHaveLength(1)
  })

  it("flips state back to 'active' when the user sends the next message", async () => {
    h = newHarness([
      [
        {
          delta: '',
          done: true,
          inputTokens: 5,
          outputTokens: 5,
          finishReason: 'tool_calls',
          toolCalls: [requestInputToolCall()],
        },
      ],
      [
        { delta: 'Acknowledged.', done: false },
        {
          delta: '',
          done: true,
          inputTokens: 1,
          outputTokens: 2,
          finishReason: 'stop',
        },
      ],
    ])
    const session = h.store.createSession({ agentProfile: 'test' })

    const h1 = await h.orchestrator.handleUserMessage(session.id, 'hi')
    await drain(h1.stream)
    expect(h.store.getSession(session.id)?.state).toBe('awaiting_input')

    const h2 = await h.orchestrator.handleUserMessage(session.id, 'project p1')
    await drain(h2.stream)

    expect(h.store.getSession(session.id)?.state).toBe('active')
  })
})

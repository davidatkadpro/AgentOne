import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { createNotifications, type Notifications } from '@/modules/notifications.js'
import { buildRequestUserInputTool } from '@/skills/request-user-input-tool.js'
import type { RegisteredTool } from '@/skills/tool.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import { fakeToolContext } from './fakes.js'

interface Harness {
  db: Db
  store: ConversationStore
  notifications: Notifications
  tool: RegisteredTool
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const store = createConversationStore(db)
  const notifications = createNotifications(db)
  const tool = buildRequestUserInputTool()
  return { db, store, notifications, tool }
}

function disposeHarness(h: Harness): void {
  h.db.close()
}

describe('request_user_input — flips state and creates notification', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    disposeHarness(h)
  })

  it("sets the session to 'awaiting_input' and creates an attention_needed notification", async () => {
    const session = h.store.createSession({ agentProfile: 'general' })
    const ctx = fakeToolContext({
      sessionId: session.id,
      services: { conversationStore: h.store, notifications: h.notifications },
    })

    const result = await h.tool.handler(
      { question: 'Which project does this email belong to?' },
      ctx,
    )

    expect(result.ok).toBe(true)
    expect(h.store.getSession(session.id)?.state).toBe('awaiting_input')

    const unread = h.notifications.list({ status: 'unread' })
    expect(unread).toHaveLength(1)
    expect(unread[0].kind).toBe('attention_needed')
    expect(unread[0].sessionId).toBe(session.id)
    expect(unread[0].title).toContain('Which project')
  })

  it('emits session.awaiting_input on the event bus', async () => {
    const session = h.store.createSession({ agentProfile: 'general' })
    const bus = new EventBus()
    const captured: AgentEvent[] = []
    bus.on('session.awaiting_input', (e) => {
      captured.push(e)
    })

    const ctx = fakeToolContext({
      sessionId: session.id,
      services: { conversationStore: h.store, notifications: h.notifications, eventBus: bus },
    })

    await h.tool.handler({ question: 'Which project?' }, ctx)

    expect(captured).toHaveLength(1)
    const evt = captured[0]
    expect(evt.type).toBe('session.awaiting_input')
    if (evt.type === 'session.awaiting_input') {
      expect(evt.sessionId).toBe(session.id)
      expect(evt.question).toBe('Which project?')
      expect(evt.notificationId).toBeGreaterThan(0)
      const stored = h.notifications.get(evt.notificationId)
      expect(stored).toBeDefined()
    }
  })

  it('includes structured options on the notification payload when provided', async () => {
    const session = h.store.createSession({ agentProfile: 'general' })
    const ctx = fakeToolContext({
      sessionId: session.id,
      services: { conversationStore: h.store, notifications: h.notifications },
    })

    const options = [
      { label: 'Riverside Reno (24001)', value: 'proj-24001' },
      { label: 'Maple Addition (24002)', value: 'proj-24002' },
      { label: 'Create new project', value: '__new__' },
    ]

    await h.tool.handler(
      { question: 'Which project does this email belong to?', options },
      ctx,
    )

    const [unread] = h.notifications.list({ status: 'unread' })
    expect(unread.payload).toEqual({ options })
  })

  it("defaults notification payload to {} when no options are given", async () => {
    const session = h.store.createSession({ agentProfile: 'general' })
    const ctx = fakeToolContext({
      sessionId: session.id,
      services: { conversationStore: h.store, notifications: h.notifications },
    })

    await h.tool.handler({ question: 'Continue?' }, ctx)

    const [unread] = h.notifications.list({ status: 'unread' })
    expect(unread.payload).toEqual({})
  })
})

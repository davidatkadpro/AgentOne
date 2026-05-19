import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { buildHistoryCoreTools } from '@/skills/history-core-tools.js'
import type { ToolContext } from '@/skills/tool.js'
import type { StorageAdapter } from '@/storage/adapter.js'
import type { WikiEngine } from '@/memory/wiki/engine.js'

function makeCtx(store: ConversationStore): ToolContext {
  return {
    sessionId: 'current',
    agentProfile: 'test',
    services: {
      storage: {} as unknown as StorageAdapter,
      wiki: {} as unknown as WikiEngine,
      conversationStore: store,
    },
  }
}

describe('search_history tool', () => {
  let db: Db
  let store: ConversationStore

  beforeEach(() => {
    db = createDatabase({ path: ':memory:', skipMkdir: true })
    store = createConversationStore(db)
  })
  afterEach(() => {
    db.close()
  })

  it('exposes a search_history tool with FTS5-aware description', () => {
    const tools = buildHistoryCoreTools()
    expect(tools.length).toBe(1)
    expect(tools[0].id).toBe('search_history')
    expect(tools[0].source).toBe('core')
  })

  it('returns hits via the searchTurns store method', async () => {
    const session = store.createSession({ agentProfile: 'p', title: 'T' })
    store.appendTurn({
      sessionId: session.id,
      role: 'user',
      content: 'David prefers tea over coffee in winter.',
    })
    const [tool] = buildHistoryCoreTools()
    const parsed = tool.parameters.parse({ query: 'tea' })
    const result = await tool.handler(parsed, makeCtx(store))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const payload = result.value as { count: number; hits: Array<{ session_id: string }> }
    expect(payload.count).toBe(1)
    expect(payload.hits[0].session_id).toBe(session.id)
  })

  it('rejects sessionId + exclude_session_id with a validation error', async () => {
    const [tool] = buildHistoryCoreTools()
    const parsed = tool.parameters.parse({
      query: 'x',
      session_id: 'a',
      exclude_session_id: 'b',
    })
    const result = await tool.handler(parsed, makeCtx(store))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('TOOL_VALIDATION')
  })

  it('returns TOOL_VALIDATION for an FTS5 syntax error', async () => {
    const [tool] = buildHistoryCoreTools()
    const parsed = tool.parameters.parse({ query: '"unterminated' })
    const result = await tool.handler(parsed, makeCtx(store))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('TOOL_VALIDATION')
    expect(result.error.recoverable).toBe(true)
  })
})

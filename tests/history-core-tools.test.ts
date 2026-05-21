import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { buildHistoryCoreTools } from '@/skills/history-core-tools.js'
import type { ToolContext } from '@/skills/tool.js'
import type { HybridRecall } from '@/search/hybrid.js'
import { fakeToolContext } from './fakes.js'

function makeCtx(store: ConversationStore): ToolContext {
  // Test-only recall stub: delegate straight to the FTS5 store path so the
  // existing history-core-tools tests still exercise the same behaviour.
  const recall: HybridRecall = {
    async searchHistory(opts) {
      return store.searchTurns(opts)
    },
  }
  return fakeToolContext({
    sessionId: 'current',
    services: { conversationStore: store, recall },
  })
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

  it('exposes search_history and read_turn as core tools', () => {
    const tools = buildHistoryCoreTools()
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('search_history')
    expect(ids).toContain('read_turn')
    for (const t of tools) expect(t.source).toBe('core')
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

describe('read_turn tool', () => {
  let db: Db
  let store: ConversationStore

  beforeEach(() => {
    db = createDatabase({ path: ':memory:', skipMkdir: true })
    store = createConversationStore(db)
  })
  afterEach(() => {
    db.close()
  })

  function getReadTurn() {
    return buildHistoryCoreTools().find((t) => t.id === 'read_turn')!
  }

  it('returns full content for a turn id, page 1', async () => {
    const session = store.createSession({ agentProfile: 'p' })
    const turn = store.appendTurn({
      sessionId: session.id,
      role: 'user',
      content: 'hello world',
    })
    const tool = getReadTurn()
    const parsed = tool.parameters.parse({ id: turn.id })
    const result = await tool.handler(parsed, makeCtx(store))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const payload = result.value as { meta: { kind: string; id: string }; content: string; total_pages: number }
    expect(payload.meta.kind).toBe('turn')
    expect(payload.meta.id).toBe(turn.id)
    expect(payload.content).toBe('hello world')
    expect(payload.total_pages).toBe(1)
  })

  it('paginates a long turn into multiple pages', async () => {
    const session = store.createSession({ agentProfile: 'p' })
    const long = 'a'.repeat(10_000)
    const turn = store.appendTurn({ sessionId: session.id, role: 'assistant', content: long })

    const tool = getReadTurn()
    const p1 = await tool.handler(
      tool.parameters.parse({ id: turn.id, page: 1, page_size: 4000 }),
      makeCtx(store),
    )
    expect(p1.ok).toBe(true)
    if (!p1.ok) return
    const payload1 = p1.value as { content: string; total_pages: number; page: number }
    expect(payload1.content.length).toBe(4000)
    expect(payload1.total_pages).toBe(3) // 4000 + 4000 + 2000
    expect(payload1.page).toBe(1)

    const p3 = await tool.handler(
      tool.parameters.parse({ id: turn.id, page: 3, page_size: 4000 }),
      makeCtx(store),
    )
    if (!p3.ok) return
    const payload3 = p3.value as { content: string; page: number }
    expect(payload3.content.length).toBe(2000)
    expect(payload3.page).toBe(3)
  })

  it('clamps page > total_pages to the last page', async () => {
    const session = store.createSession({ agentProfile: 'p' })
    const turn = store.appendTurn({ sessionId: session.id, role: 'user', content: 'short' })
    const tool = getReadTurn()
    const result = await tool.handler(
      tool.parameters.parse({ id: turn.id, page: 999 }),
      makeCtx(store),
    )
    if (!result.ok) return
    const payload = result.value as { page: number; total_pages: number }
    expect(payload.page).toBe(1) // clamped to the only available page
    expect(payload.total_pages).toBe(1)
  })

  it('resolves a tool_call_id when the turn lookup misses', async () => {
    const session = store.createSession({ agentProfile: 'p' })
    const assistantTurn = store.appendTurn({
      sessionId: session.id,
      role: 'assistant',
      content: '',
    })
    const row = store.appendToolCall({
      turnId: assistantTurn.id,
      toolCallId: 'llm-tool-call-xyz',
      tool: 'wiki_read',
      argsJson: '{"path":"x"}',
    })
    store.recordToolCallResult({
      id: row.id,
      resultJson: JSON.stringify({ ok: true, value: { body: 'big tool output' } }),
      ok: true,
      durationMs: 5,
    })

    const tool = getReadTurn()
    const result = await tool.handler(
      tool.parameters.parse({ id: 'llm-tool-call-xyz' }),
      makeCtx(store),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const payload = result.value as { meta: { kind: string; id: string; tool?: string }; content: string }
    expect(payload.meta.kind).toBe('tool_call_result')
    expect(payload.meta.id).toBe('llm-tool-call-xyz')
    expect(payload.meta.tool).toBe('wiki_read')
    expect(payload.content).toContain('big tool output')
  })

  it('returns RESOURCE_UNAVAILABLE for an unknown id', async () => {
    const tool = getReadTurn()
    const result = await tool.handler(
      tool.parameters.parse({ id: 'never-existed' }),
      makeCtx(store),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('RESOURCE_UNAVAILABLE')
  })
})

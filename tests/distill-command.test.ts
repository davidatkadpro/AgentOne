import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distillCommand, renderDistillSummary } from '@/server/commands/distill.js'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { WikiEngine } from '@/memory/wiki/engine.js'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import type { CommandContext } from '@/server/commands/types.js'
import type { SkillIndex } from '@/skills/loader.js'
import type { Orchestrator } from '@/orchestrator/turn.js'
import type { ContextManager } from '@/context/context-manager.js'
import type { ServerConfig } from '@/server/config.js'
import { FakeProvider } from './fakes.js'

function emptySkillIndex(): SkillIndex {
  return { skills: new Map(), categories: new Map(), bySlashCommand: new Map() }
}

function fakeConfig(): ServerConfig {
  return {} as ServerConfig
}

interface Harness {
  db: Db
  store: ConversationStore
  wiki: WikiEngine
  root: string
  cleanup: () => Promise<void>
  ctx: (sessionId: string | null, provider: FakeProvider) => CommandContext
}

async function newHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'agentone-distill-'))
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const store = createConversationStore(db)
  const storage = new LocalFolderAdapter({ root })
  const wiki = new WikiEngine({ storage, db, skipInitialReindex: true })

  return {
    db,
    store,
    wiki,
    root,
    async cleanup() {
      db.close()
      await rm(root, { recursive: true, force: true })
    },
    ctx: (sessionId, provider) => ({
      sessionId,
      store,
      skillIndex: emptySkillIndex(),
      orchestrator: {} as unknown as Orchestrator,
      contextManager: {} as unknown as ContextManager,
      config: fakeConfig(),
      wiki,
      compressorProvider: provider,
      compressorModel: 'fake-model',
    }),
  }
}

async function readWikiFile(root: string, relPath: string): Promise<string> {
  return readFile(join(root, 'wiki', relPath), 'utf-8')
}

describe('/distill command', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  it('returns "nothing to distill" on a session with no turns', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    const provider = new FakeProvider({ respond: () => '[]' })
    const result = await distillCommand.handler({}, h.ctx(session.id, provider))
    expect(result.kind).toBe('text')
    expect((result as { content: string }).content).toContain('no turns')
    // The provider must not be called when there's nothing to distill.
    expect(provider.calls).toHaveLength(0)
  })

  it('writes a draft page when the model returns notes', async () => {
    const session = h.store.createSession({ agentProfile: 'p', title: 'Conversation A' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'I prefer TypeScript over JavaScript' })
    h.store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'Got it.' })

    const provider = new FakeProvider({
      respond: () =>
        JSON.stringify([
          { kind: 'preference', title: 'TypeScript over JavaScript', body: 'User prefers TS.' },
        ]),
    })
    const result = await distillCommand.handler({}, h.ctx(session.id, provider))
    expect(result.kind).toBe('text')
    const content = (result as { content: string }).content
    expect(content).toContain('Distilled 1 note')
    expect(content).toContain('drafts/distilled-')
    expect(content).toContain('preference: 1')

    // Verify the page was actually written.
    const dateSlug = new Date().toISOString().slice(0, 10)
    const path = `drafts/distilled-${session.id}-${dateSlug}.md`
    const written = await readWikiFile(h.root, path)
    expect(written).toContain('## preference')
    expect(written).toContain('TypeScript over JavaScript')
    expect(written).toContain(`source_session: ${session.id}`)
  })

  it('returns "no facts" without writing when the model returns []', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'ok' })

    const provider = new FakeProvider({ respond: () => '[]' })
    const result = await distillCommand.handler({}, h.ctx(session.id, provider))
    expect(result.kind).toBe('text')
    expect((result as { content: string }).content).toContain('No durable facts extracted')
  })

  it('surfaces a parse-failure hint when the model returned non-JSON', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'hello' })

    const provider = new FakeProvider({ respond: () => 'I refuse to comply.' })
    const result = await distillCommand.handler({}, h.ctx(session.id, provider))
    expect(result.kind).toBe('text')
    expect((result as { content: string }).content).toContain('non-JSON')
  })

  it('reports an error when the provider call throws', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'hello' })

    const provider = new FakeProvider({ failWith: new Error('LM Studio down') })
    const result = await distillCommand.handler({}, h.ctx(session.id, provider))
    expect(result.kind).toBe('error')
    expect((result as { message: string }).message).toContain('LM Studio down')
  })
})

describe('renderDistillSummary', () => {
  it('shows kind counts and the draft path', () => {
    const out = renderDistillSummary({
      notes: [
        { kind: 'preference', title: 'a', body: 'b' },
        { kind: 'preference', title: 'c', body: 'd' },
        { kind: 'project', title: 'e', body: 'f' },
      ],
      draftPath: 'drafts/distilled-sess-1-2026-05-21.md',
    })
    expect(out).toContain('Distilled 3 notes')
    expect(out).toContain('preference: 2')
    expect(out).toContain('project: 1')
    expect(out).toContain('drafts/distilled-sess-1-2026-05-21.md')
  })
})

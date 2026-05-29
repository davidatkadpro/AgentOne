import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { CommandRegistry } from '@/server/commands/registry.js'
import { buildCommandRegistry } from '@/server/commands/builders.js'
import { sessionsCommand } from '@/server/commands/sessions.js'
import { newCommand } from '@/server/commands/new.js'
import { clearCommand } from '@/server/commands/clear.js'
import { compactCommand } from '@/server/commands/compact.js'
import { loadCommand } from '@/server/commands/load.js'
import type { CommandContext } from '@/server/commands/types.js'
import type { SkillIndex } from '@/skills/loader.js'
import type { Orchestrator } from '@/orchestrator/turn.js'
import type { ContextManager } from '@/context/context-manager.js'
import type { ServerConfig } from '@/server/config.js'

function emptySkillIndex(): SkillIndex {
  return {
    skills: new Map(),
    categories: new Map(),
    bySlashCommand: new Map(),
  }
}

function fakeConfig(): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    basePromptPath: '',
    modelProfilesDir: '',
    agentProfilesDir: '',
    agentProfile: '_base',
    skillsDir: '',
    lmStudioBaseUrl: '',
    openRouterBaseUrl: '',
    openRouterApiKey: null,
    openRouterAppTitle: 'AgentOne',
    openRouterHttpReferer: null,
    defaultModelProfile: 'local-fast',
    compressorModelProfile: 'local-compressor',
    embeddingModelProfile: 'local-embed',
    frontendDir: '',
    storageRoot: '',
    wikiPrefix: 'wiki',
    auditLogPath: null,
    eventHooksPath: null,
    emailMaildirPath: null,
    emailSourceKind: 'none',
    emailPollIntervalMinutes: 5,
    m365ClientId: null,
    m365ClientSecret: null,
    m365TenantId: 'common',
    m365RedirectUri: 'http://127.0.0.1:3737/api/integrations/m365/callback',
    m365Scopes: 'offline_access Mail.Read User.Read',
    m365AuthorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    m365TokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    qboClientId: null,
    qboClientSecret: null,
    qboRedirectUri: 'http://127.0.0.1:3737/api/integrations/qbo/callback',
    qboAuthorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    qboPullIntervalMinutes: 15,
    logEvents: false,
    allowedOrigins: [],
    allowUnauthNetwork: false,
  }
}

interface Harness {
  db: Db
  store: ConversationStore
  orchestratorCalls: Array<{ kind: string; args: unknown[] }>
  contextCalls: Array<{ kind: string; args: unknown[] }>
  ctx: (sessionId: string | null) => CommandContext
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const store = createConversationStore(db)
  const orchestratorCalls: Array<{ kind: string; args: unknown[] }> = []
  const contextCalls: Array<{ kind: string; args: unknown[] }> = []
  const fakeOrchestrator = {
    resetSession: (id: string) => orchestratorCalls.push({ kind: 'resetSession', args: [id] }),
    compactSession: async (id: string) => {
      orchestratorCalls.push({ kind: 'compactSession', args: [id] })
      return { tokensBefore: 100, tokensAfter: 40, changed: true }
    },
    loadSkillIntoSession: async (id: string, skill: string) => {
      orchestratorCalls.push({ kind: 'loadSkillIntoSession', args: [id, skill] })
      return { alreadyLoaded: false as const, loaded: true as const, toolsRegistered: ['tool_a'] }
    },
    handleUserMessage: async (id: string, text: string) => {
      orchestratorCalls.push({ kind: 'handleUserMessage', args: [id, text] })
      return { stream: (async function* () {})() }
    },
  } as unknown as Orchestrator
  const fakeContextManager = {
    reset: (id: string) => contextCalls.push({ kind: 'reset', args: [id] }),
  } as unknown as ContextManager

  const ctx = (sessionId: string | null): CommandContext => ({
    sessionId,
    store,
    skillIndex: emptySkillIndex(),
    orchestrator: fakeOrchestrator,
    contextManager: fakeContextManager,
    config: fakeConfig(),
    wiki: {} as never,
    compressorProvider: {} as never,
    compressorModel: 'unused',
    db: {} as never,
  })

  return { db, store, orchestratorCalls, contextCalls, ctx }
}

describe('CommandRegistry', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('builds with all six default commands', () => {
    const reg = buildCommandRegistry(emptySkillIndex())
    for (const name of ['help', 'sessions', 'new', 'clear', 'compact', 'load']) {
      expect(reg.has(name)).toBe(true)
    }
  })

  it('rejects duplicate registrations', () => {
    const reg = new CommandRegistry()
    reg.register(sessionsCommand)
    expect(() => reg.register(sessionsCommand)).toThrow()
  })

  it('returns error for unknown command', async () => {
    const reg = buildCommandRegistry(emptySkillIndex())
    const result = await reg.dispatch('nope', {}, h.ctx(null))
    expect(result.kind).toBe('error')
  })

  it('errors when requiresSession is unmet', async () => {
    const reg = buildCommandRegistry(emptySkillIndex())
    const result = await reg.dispatch('clear', { confirm: true }, h.ctx(null))
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.message).toMatch(/active session/)
    }
  })

  it('zod-validates args (load requires skill)', async () => {
    const reg = buildCommandRegistry(emptySkillIndex())
    const session = h.store.createSession({ agentProfile: 'p' })
    const result = await reg.dispatch('load', {}, h.ctx(session.id))
    expect(result.kind).toBe('error')
  })
})

describe('/sessions command', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('returns recent sessions with turn counts', async () => {
    const a = h.store.createSession({ agentProfile: 'p', title: 'A' })
    h.store.appendTurn({ sessionId: a.id, role: 'user', content: 'hi' })
    h.store.appendTurn({ sessionId: a.id, role: 'assistant', content: 'hello' })
    const b = h.store.createSession({ agentProfile: 'p', title: 'B' })
    const result = await sessionsCommand.handler({ limit: 20 }, h.ctx(null))
    expect(result.kind).toBe('session_list')
    if (result.kind !== 'session_list') return
    const byId = new Map(result.sessions.map((s) => [s.id, s]))
    expect(byId.get(a.id)?.turnCount).toBe(2)
    expect(byId.get(b.id)?.turnCount).toBe(0)
  })
})

describe('/new command', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('creates a new session with the configured default profile', async () => {
    const result = await newCommand.handler({}, h.ctx(null))
    expect(result.kind).toBe('session_switch')
    if (result.kind !== 'session_switch') return
    expect(result.session.agentProfile).toBe('_base')
    expect(result.reason).toBe('new')
  })

  it('honours an explicit profile arg', async () => {
    const result = await newCommand.handler({ profile: 'analyst' }, h.ctx(null))
    expect(result.kind).toBe('session_switch')
    if (result.kind !== 'session_switch') return
    expect(result.session.agentProfile).toBe('analyst')
  })
})

describe('/clear command', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('refuses without confirm', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    const result = await clearCommand.handler({ confirm: false }, h.ctx(session.id))
    expect(result.kind).toBe('error')
  })

  it('deletes turns and resets orchestrator + context cache', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    h.store.appendTurn({ sessionId: session.id, role: 'user', content: 'one' })
    h.store.appendTurn({ sessionId: session.id, role: 'assistant', content: 'two' })
    const result = await clearCommand.handler({ confirm: true }, h.ctx(session.id))
    expect(result.kind).toBe('session_cleared')
    if (result.kind !== 'session_cleared') return
    expect(result.turnsDeleted).toBe(2)
    expect(h.store.listTurns(session.id)).toHaveLength(0)
    // Session itself is preserved
    expect(h.store.getSession(session.id)).toBeDefined()
    // Caches were invalidated
    expect(h.orchestratorCalls.some((c) => c.kind === 'resetSession')).toBe(true)
    expect(h.contextCalls.some((c) => c.kind === 'reset')).toBe(true)
  })
})

describe('/compact command', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('delegates to orchestrator.compactSession and surfaces token deltas', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    const result = await compactCommand.handler({}, h.ctx(session.id))
    expect(result.kind).toBe('context_compacted')
    if (result.kind !== 'context_compacted') return
    expect(result.tokensBefore).toBe(100)
    expect(result.tokensAfter).toBe(40)
    expect(h.orchestratorCalls).toEqual([
      { kind: 'compactSession', args: [session.id] },
    ])
  })
})

describe('/load command', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('rejects unknown skills', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    const result = await loadCommand.handler(
      { skill: 'system/missing' },
      h.ctx(session.id),
    )
    expect(result.kind).toBe('error')
  })

  it('delegates loading and reports registered tools', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    const skillIndex = emptySkillIndex()
    skillIndex.skills.set('system/docs', {} as never)
    const ctx: CommandContext = { ...h.ctx(session.id), skillIndex }
    const result = await loadCommand.handler({ skill: 'system/docs' }, ctx)
    expect(result.kind).toBe('skill_loaded')
    if (result.kind !== 'skill_loaded') return
    expect(result.skill).toBe('system/docs')
    expect(result.toolsRegistered).toEqual(['tool_a'])
    expect(result.alreadyLoaded).toBe(false)
  })

  it('surfaces failure reason when the orchestrator reports load failed', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    const skillIndex = emptySkillIndex()
    skillIndex.skills.set('system/denied', {} as never)
    const fakeOrch = {
      loadSkillIntoSession: async () => ({
        alreadyLoaded: false as const,
        loaded: false as const,
        reason: 'permission denied: profile forbids it',
      }),
    } as unknown as Orchestrator
    const ctx: CommandContext = { ...h.ctx(session.id), skillIndex, orchestrator: fakeOrch }
    const result = await loadCommand.handler({ skill: 'system/denied' }, ctx)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.message).toMatch(/permission denied/)
    expect(result.recoverable).toBe(true)
  })

  it('reports alreadyLoaded as a skill_loaded result, not text', async () => {
    const session = h.store.createSession({ agentProfile: 'p' })
    const skillIndex = emptySkillIndex()
    skillIndex.skills.set('system/already', {} as never)
    const fakeOrch = {
      loadSkillIntoSession: async () => ({
        alreadyLoaded: true as const,
        toolsRegistered: [] as [],
      }),
    } as unknown as Orchestrator
    const ctx: CommandContext = { ...h.ctx(session.id), skillIndex, orchestrator: fakeOrch }
    const result = await loadCommand.handler({ skill: 'system/already' }, ctx)
    expect(result.kind).toBe('skill_loaded')
    if (result.kind !== 'skill_loaded') return
    expect(result.alreadyLoaded).toBe(true)
    expect(result.toolsRegistered).toEqual([])
  })
})

describe('/compact command on short history', () => {
  it('returns a "nothing to compact" text result, not a misleading 0-delta event', async () => {
    const db = createDatabase({ path: ':memory:', skipMkdir: true })
    const store = createConversationStore(db)
    const session = store.createSession({ agentProfile: 'p' })
    const fakeOrch = {
      compactSession: async () => ({ tokensBefore: 50, tokensAfter: 50, changed: false }),
    } as unknown as Orchestrator
    const ctx: CommandContext = {
      sessionId: session.id,
      store,
      skillIndex: emptySkillIndex(),
      orchestrator: fakeOrch,
      contextManager: {} as unknown as ContextManager,
      config: fakeConfig(),
      wiki: {} as never,
      compressorProvider: {} as never,
      compressorModel: 'unused',
    db: {} as never,
    }
    const result = await compactCommand.handler({}, ctx)
    expect(result.kind).toBe('text')
    db.close()
  })
})

describe('CommandRegistry.dispatch error handling', () => {
  it('catches thrown handler errors and converts to error result', async () => {
    const reg = new CommandRegistry()
    reg.register({
      name: 'blowup',
      description: 'always throws',
      usage: '/blowup',
      args: z.object({}),
      requiresSession: false,
      handler: async () => {
        throw new Error('boom')
      },
    })
    const db = createDatabase({ path: ':memory:', skipMkdir: true })
    const store = createConversationStore(db)
    const ctx: CommandContext = {
      sessionId: null,
      store,
      skillIndex: emptySkillIndex(),
      orchestrator: {} as unknown as Orchestrator,
      contextManager: {} as unknown as ContextManager,
      config: fakeConfig(),
      wiki: {} as never,
      compressorProvider: {} as never,
      compressorModel: 'unused',
    db: {} as never,
    }
    // Silence the expected console.error from the catch path.
    const originalError = console.error
    console.error = () => {}
    try {
      const result = await reg.dispatch('blowup', {}, ctx)
      expect(result.kind).toBe('error')
      if (result.kind !== 'error') return
      expect(result.message).toBe('boom')
      expect(result.recoverable).toBe(false)
    } finally {
      console.error = originalError
      db.close()
    }
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'
import { costCommand, renderCostReport } from '@/server/commands/cost.js'
import type { CommandContext, CommandResult } from '@/server/commands/types.js'
import type { ServerConfig } from '@/server/config.js'
import type { Orchestrator } from '@/orchestrator/turn.js'
import type { ContextManager } from '@/context/context-manager.js'
import type { SkillIndex } from '@/skills/loader.js'

function emptySkillIndex(): SkillIndex {
  return { skills: new Map(), categories: new Map(), bySlashCommand: new Map() }
}

function fakeConfig(agentProfilesDir: string): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    basePromptPath: '',
    modelProfilesDir: '',
    agentProfilesDir,
    agentProfile: 'researcher',
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
    logEvents: false,
  }
}

function makeCtx(args: {
  sessionId: string | null
  store: ConversationStore
  agentProfilesDir?: string
}): CommandContext {
  return {
    sessionId: args.sessionId,
    store: args.store,
    skillIndex: emptySkillIndex(),
    orchestrator: {} as unknown as Orchestrator,
    contextManager: {} as unknown as ContextManager,
    config: fakeConfig(args.agentProfilesDir ?? ''),
    wiki: {} as never,
    compressorProvider: {} as never,
    compressorModel: 'unused',
    db: {} as never,
  }
}

describe('renderCostReport', () => {
  it('renders empty state cleanly', () => {
    const out = renderCostReport({
      sessionSpend: { totalUsd: 0, totalCalls: 0, byModel: [] },
      lifetimeSpend: { totalUsd: 0, totalCalls: 0, byModel: [] },
      budget: { perCallUsd: 0.5, perSessionUsd: 5, sessionRemainingUsd: 5 },
    })
    expect(out).toContain('This session: $0.000000 (0 calls)')
    expect(out).toContain('(no expert calls in this session yet)')
    expect(out).toContain('Lifetime:     $0.000000 (0 calls)')
    expect(out).toContain('(no expert calls recorded)')
    expect(out).toContain('per-call:    $0.500000')
    expect(out).toContain('per-session: $5.000000 ($5.000000 remaining)')
  })

  it('renders per-model breakdown and singular call grammar', () => {
    const out = renderCostReport({
      sessionSpend: {
        totalUsd: 0.000144,
        totalCalls: 1,
        byModel: [{ model: 'openrouter-claude-sonnet', calls: 1, costUsd: 0.000144 }],
      },
      lifetimeSpend: {
        totalUsd: 0.05,
        totalCalls: 27,
        byModel: [
          { model: 'openrouter-claude-sonnet', calls: 25, costUsd: 0.04 },
          { model: 'openrouter-deepseek', calls: 2, costUsd: 0.01 },
        ],
      },
      budget: { perCallUsd: 0.5, perSessionUsd: 5, sessionRemainingUsd: 4.999856 },
    })
    expect(out).toContain('This session: $0.000144 (1 call)')
    expect(out).toContain('openrouter-claude-sonnet: 1 call, $0.000144')
    expect(out).toContain('Lifetime:     $0.050000 (27 calls)')
    expect(out).toContain('openrouter-deepseek: 2 calls, $0.010000')
    expect(out).toContain('$4.999856 remaining')
  })

  it('shows "unlimited" when a budget is null', () => {
    const out = renderCostReport({
      sessionSpend: { totalUsd: 0, totalCalls: 0, byModel: [] },
      lifetimeSpend: { totalUsd: 0, totalCalls: 0, byModel: [] },
      budget: { perCallUsd: null, perSessionUsd: null, sessionRemainingUsd: null },
    })
    expect(out).toContain('per-call:    unlimited')
    expect(out).toContain('per-session: unlimited')
  })

  it('reports unavailable when budget is null (profile failed to load)', () => {
    const out = renderCostReport({
      sessionSpend: { totalUsd: 0, totalCalls: 0, byModel: [] },
      lifetimeSpend: { totalUsd: 0, totalCalls: 0, byModel: [] },
      budget: null,
    })
    expect(out).toContain('(unavailable — could not load agent profile)')
  })
})

describe('/cost command handler', () => {
  let db: Db
  let store: ConversationStore
  let profilesDir: string

  beforeEach(async () => {
    db = createDatabase({ path: ':memory:', skipMkdir: true })
    store = createConversationStore(db)
    profilesDir = await mkdtemp(join(tmpdir(), 'agentone-cost-profiles-'))
  })

  afterEach(async () => {
    db.close()
    await rm(profilesDir, { recursive: true, force: true })
  })

  it('errors when there is no session context', async () => {
    const result = await costCommand.handler(
      {} as never,
      makeCtx({ sessionId: 'missing', store }),
    )
    expect(result.kind).toBe('error')
    expect((result as Extract<CommandResult, { kind: 'error' }>).message).toMatch(/Session not found/)
  })

  it('reports session and lifetime spend with budget context from a real profile YAML', async () => {
    // Set up a researcher profile on disk with non-trivial budgets.
    await writeFile(
      join(profilesDir, '_base.yaml'),
      `id: _base
default_model: local-fast
default_skills: []
permissions:
  skills: { allow: [], deny: [] }
  experts: { allow: [] }
`,
    )
    await writeFile(
      join(profilesDir, 'researcher.yaml'),
      `id: researcher
extends: _base
default_model: local-fast
default_skills: []
permissions:
  skills: { allow: [], deny: [] }
  experts:
    allow: [openrouter-claude-sonnet]
    budget_per_call_usd: 0.5
    budget_per_session_usd: 5.0
`,
    )
    const session = store.createSession({ agentProfile: 'researcher' })
    const otherSession = store.createSession({ agentProfile: 'researcher' })

    // Two calls in the current session + one call in another session
    // (counts in lifetime, not session).
    store.appendExpertSpend({
      sessionId: session.id, model: 'openrouter-claude-sonnet',
      costUsd: 0.0001, inputTokens: 10, outputTokens: 4,
    })
    store.appendExpertSpend({
      sessionId: session.id, model: 'openrouter-claude-sonnet',
      costUsd: 0.0002, inputTokens: 15, outputTokens: 5,
    })
    store.appendExpertSpend({
      sessionId: otherSession.id, model: 'openrouter-claude-sonnet',
      costUsd: 0.001, inputTokens: 50, outputTokens: 20,
    })

    const result = await costCommand.handler(
      {} as never,
      makeCtx({ sessionId: session.id, store, agentProfilesDir: profilesDir }),
    )
    expect(result.kind).toBe('text')
    const content = (result as Extract<CommandResult, { kind: 'text' }>).content
    expect(content).toContain('This session: $0.000300 (2 calls)')
    expect(content).toContain('Lifetime:     $0.001300 (3 calls)')
    expect(content).toContain('per-call:    $0.500000')
    expect(content).toContain('per-session: $5.000000 ($4.999700 remaining)')
  })

  it('falls back to "unavailable" budget when the profile YAML is missing', async () => {
    const session = store.createSession({ agentProfile: 'researcher' })
    // No yaml files written — load will fail.
    const result = await costCommand.handler(
      {} as never,
      makeCtx({ sessionId: session.id, store, agentProfilesDir: profilesDir }),
    )
    expect(result.kind).toBe('text')
    const content = (result as Extract<CommandResult, { kind: 'text' }>).content
    expect(content).toContain('(unavailable — could not load agent profile)')
    // Spend section still renders normally.
    expect(content).toContain('This session: $0.000000')
  })
})

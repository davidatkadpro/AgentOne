import { describe, it, expect } from 'vitest'
import { ProviderRegistry } from '@/providers/registry.js'
import { ExpertSpendTracker } from '@/skills/expert-spend.js'
import { PermissionGate } from '@/profiles/permission-gate.js'
import { EventBus } from '@/core/events.js'
import type { ResolvedAgentProfile } from '@/profiles/agent-profile.js'
import type { ModelProfile } from '@/core/types.js'
import type { ToolContext } from '@/skills/tool.js'
import { FakeProvider, fakeToolContext } from './fakes.js'
import { handler as consultHandler } from '../skills/experts/consult/tools/consult.js'

function expertProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'sonnet',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    role: 'expert',
    contextWindow: 200000,
    params: { temperature: 0.4, maxTokens: 2048, topP: 1 },
    ...overrides,
  }
}

function makeProfile(opts: {
  allow?: string[]
  perCall?: number | null
  perSession?: number | null
}): ResolvedAgentProfile {
  return {
    id: 'researcher',
    systemPromptFile: null,
    defaultModel: 'local-fast',
    compressorModel: null,
    defaultSkills: [],
    permissions: {
      skills: { allow: [], deny: [] },
      experts: {
        allow: opts.allow ?? [],
        budgetPerCallUsd: opts.perCall ?? null,
        budgetPerSessionUsd: opts.perSession ?? null,
      },
    },
    passiveRecall: { enabled: false, wikiHits: 2, historyHits: 2, maxCharsPerHit: 240 },
    autoDistill: { enabled: false, idleMinutes: 30, scanIntervalMinutes: 5 },
    denyTools: [],
    sourceFile: '',
  }
}

function makeCtx(opts: {
  profile: ResolvedAgentProfile
  modelProfiles: Map<string, ModelProfile>
  providers: ProviderRegistry
  spend?: ExpertSpendTracker
  bus?: EventBus
}): ToolContext {
  return fakeToolContext({
    sessionId: 'sess-1',
    agentProfile: opts.profile.id,
    services: {
      providers: opts.providers,
      modelProfiles: opts.modelProfiles,
      eventBus: opts.bus ?? new EventBus(),
    },
    permissions: new PermissionGate(opts.profile),
    expertSpend: opts.spend ?? new ExpertSpendTracker(),
  })
}

describe('consult_expert tool', () => {
  it('returns the expert reply and tracks reported cost', async () => {
    const fake = new FakeProvider({ id: 'openrouter', respond: () => 'expert reply', costUsd: 0.05 })
    const providers = new ProviderRegistry()
    providers.register(fake)
    const profiles = new Map<string, ModelProfile>([['sonnet', expertProfile()]])
    const ctx = makeCtx({
      profile: makeProfile({ allow: ['sonnet'] }),
      modelProfiles: profiles,
      providers,
    })

    const events: string[] = []
    ctx.services.eventBus.onAny((e) => {
      events.push(e.type)
    })

    const result = await consultHandler(
      { expert: 'sonnet', question: 'why?', context: 'ctx' },
      ctx,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value).toMatchObject({
      expert: 'sonnet',
      reply: 'expert reply',
      cost_usd: 0.05,
      session_spend_usd: 0.05,
    })
    expect(ctx.expertSpend.total).toBeCloseTo(0.05, 4)
    expect(events).toContain('expert.consulted')
  })

  it('denies when the expert is not in the agent profile allow-list', async () => {
    const providers = new ProviderRegistry()
    providers.register(new FakeProvider({ id: 'openrouter' }))
    const ctx = makeCtx({
      profile: makeProfile({ allow: [] }),
      modelProfiles: new Map([['sonnet', expertProfile()]]),
      providers,
    })

    const result = await consultHandler(
      { expert: 'sonnet', question: 'q', context: 'c' },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('PERMISSION_DENIED')
  })

  it('rejects pre-call when session budget is already exhausted', async () => {
    const fake = new FakeProvider({ id: 'openrouter', costUsd: 0.10 })
    const providers = new ProviderRegistry()
    providers.register(fake)
    const spend = new ExpertSpendTracker()
    spend.add('sonnet', 0.50) // already at cap
    const ctx = makeCtx({
      profile: makeProfile({ allow: ['sonnet'], perSession: 0.50 }),
      modelProfiles: new Map([['sonnet', expertProfile()]]),
      providers,
      spend,
    })

    const result = await consultHandler(
      { expert: 'sonnet', question: 'q', context: 'c' },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('BUDGET_EXCEEDED')
    expect(fake.calls.length).toBe(0)
  })

  it('emits expert.budget_exceeded when a call exceeds per-call cap (but still returns)', async () => {
    const fake = new FakeProvider({ id: 'openrouter', respond: () => 'pricey', costUsd: 1.50 })
    const providers = new ProviderRegistry()
    providers.register(fake)
    const ctx = makeCtx({
      profile: makeProfile({ allow: ['sonnet'], perCall: 0.50 }),
      modelProfiles: new Map([['sonnet', expertProfile()]]),
      providers,
    })

    const events: string[] = []
    ctx.services.eventBus.onAny((e) => {
      events.push(e.type)
    })

    const result = await consultHandler(
      { expert: 'sonnet', question: 'q', context: 'c' },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(events).toContain('expert.consulted')
    expect(events).toContain('expert.budget_exceeded')
  })

  it('rejects when the expert profile is missing or has wrong role', async () => {
    const providers = new ProviderRegistry()
    providers.register(new FakeProvider({ id: 'openrouter' }))

    const noProfileCtx = makeCtx({
      profile: makeProfile({ allow: ['sonnet'] }),
      modelProfiles: new Map(),
      providers,
    })
    const noProfile = await consultHandler(
      { expert: 'sonnet', question: 'q', context: 'c' },
      noProfileCtx,
    )
    expect(noProfile.ok).toBe(false)

    const wrongRoleCtx = makeCtx({
      profile: makeProfile({ allow: ['sonnet'] }),
      modelProfiles: new Map([['sonnet', expertProfile({ role: 'general' })]]),
      providers,
    })
    const wrongRole = await consultHandler(
      { expert: 'sonnet', question: 'q', context: 'c' },
      wrongRoleCtx,
    )
    expect(wrongRole.ok).toBe(false)
  })

  it('reports a clear error when the expert provider is not registered', async () => {
    const providers = new ProviderRegistry()
    // No openrouter — only lmstudio
    providers.register(new FakeProvider({ id: 'lmstudio' }))
    const ctx = makeCtx({
      profile: makeProfile({ allow: ['sonnet'] }),
      modelProfiles: new Map([['sonnet', expertProfile()]]),
      providers,
    })

    const result = await consultHandler(
      { expert: 'sonnet', question: 'q', context: 'c' },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('RESOURCE_UNAVAILABLE')
    expect(result.error.message).toMatch(/openrouter/)
  })
})

describe('ExpertSpendTracker', () => {
  it('accumulates spend and per-model breakdown', () => {
    const t = new ExpertSpendTracker()
    t.add('sonnet', 0.10)
    t.add('sonnet', 0.05)
    t.add('opus', 0.20)
    expect(t.total).toBeCloseTo(0.35, 4)
    const sonnet = t.byModel().find((b) => b.model === 'sonnet')
    expect(sonnet?.calls).toBe(2)
    expect(sonnet?.usd).toBeCloseTo(0.15, 4)
    const opus = t.byModel().find((b) => b.model === 'opus')
    expect(opus?.calls).toBe(1)
    expect(opus?.usd).toBeCloseTo(0.20, 4)
  })

  it('ignores negative or non-finite values', () => {
    const t = new ExpertSpendTracker()
    t.add('m', -1)
    t.add('m', Number.NaN)
    t.add('m', Number.POSITIVE_INFINITY)
    expect(t.total).toBe(0)
  })
})

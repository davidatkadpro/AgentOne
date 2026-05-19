import { describe, it, expect } from 'vitest'
import { PermissionGate, matches } from '@/profiles/permission-gate.js'
import type { ResolvedAgentProfile } from '@/profiles/agent-profile.js'

function profile(overrides: {
  skillsAllow?: string[]
  skillsDeny?: string[]
  expertsAllow?: string[]
}): ResolvedAgentProfile {
  return {
    id: 'test',
    systemPromptFile: null,
    defaultModel: 'local-fast',
    compressorModel: null,
    defaultSkills: [],
    permissions: {
      skills: {
        allow: overrides.skillsAllow ?? [],
        deny: overrides.skillsDeny ?? [],
      },
      experts: {
        allow: overrides.expertsAllow ?? [],
        budgetPerCallUsd: null,
        budgetPerSessionUsd: null,
      },
    },
    sourceFile: '/tmp/test.yaml',
  }
}

describe('glob matches()', () => {
  it('matches exact literal', () => {
    expect(matches('system/filesystem', 'system/filesystem')).toBe(true)
  })

  it('matches with * (single segment)', () => {
    expect(matches('system/filesystem', 'system/*')).toBe(true)
    expect(matches('system/sub/x', 'system/*')).toBe(false)
  })

  it('matches with ** (any tail)', () => {
    expect(matches('system/filesystem', 'system/**')).toBe(true)
    expect(matches('system/sub/x/y', 'system/**')).toBe(true)
    expect(matches('research/foo', 'system/**')).toBe(false)
  })

  it('returns false for non-pattern non-match', () => {
    expect(matches('system/filesystem', 'system/shell')).toBe(false)
  })
})

describe('PermissionGate.canLoadSkill', () => {
  it('denies when nothing allows', () => {
    const gate = new PermissionGate(profile({}))
    const d = gate.canLoadSkill('system/filesystem')
    expect(d.verdict).toBe('deny')
  })

  it('allows when a glob matches and no deny matches', () => {
    const gate = new PermissionGate(profile({ skillsAllow: ['system/*'] }))
    expect(gate.canLoadSkill('system/filesystem').verdict).toBe('allow')
  })

  it('denies when deny matches even if allow also matches', () => {
    const gate = new PermissionGate(
      profile({ skillsAllow: ['system/*'], skillsDeny: ['system/shell'] }),
    )
    expect(gate.canLoadSkill('system/shell').verdict).toBe('deny')
    expect(gate.canLoadSkill('system/filesystem').verdict).toBe('allow')
  })

  it('deny-precedence: any-deny outranks any-allow', () => {
    const gate = new PermissionGate(
      profile({ skillsAllow: ['system/*', 'system/shell'], skillsDeny: ['system/shell'] }),
    )
    expect(gate.canLoadSkill('system/shell').verdict).toBe('deny')
  })

  it('surfaces a reason on deny', () => {
    const gate = new PermissionGate(profile({}))
    const d = gate.canLoadSkill('system/filesystem')
    expect(d.verdict).toBe('deny')
    expect(d.reason).toMatch(/no allow rule/)
  })

  it('exact match allows over glob deny', () => {
    // PRD: deny-precedence union. Even an exact allow loses to a matching deny.
    const gate = new PermissionGate(
      profile({ skillsAllow: ['system/shell'], skillsDeny: ['system/*'] }),
    )
    expect(gate.canLoadSkill('system/shell').verdict).toBe('deny')
  })
})

describe('PermissionGate.canCallExpert', () => {
  it('allows experts on the list', () => {
    const gate = new PermissionGate(profile({ expertsAllow: ['opus-4.7', 'deepseek-v4'] }))
    expect(gate.canCallExpert('opus-4.7').verdict).toBe('allow')
  })

  it('denies experts not on the list', () => {
    const gate = new PermissionGate(profile({ expertsAllow: ['opus-4.7'] }))
    expect(gate.canCallExpert('gpt-5.5').verdict).toBe('deny')
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgentProfile } from '@/profiles/agent-profile.js'

let dir: string

async function write(name: string, contents: string) {
  await writeFile(join(dir, `${name}.yaml`), contents)
}

describe('loadAgentProfile', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentone-profiles-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loads a minimal standalone profile', async () => {
    await write('_base', `id: _base\ndefault_model: local-fast\n`)
    const p = await loadAgentProfile(dir, '_base')
    expect(p.id).toBe('_base')
    expect(p.defaultModel).toBe('local-fast')
    expect(p.defaultSkills).toEqual([])
    expect(p.permissions.skills.allow).toEqual([])
    expect(p.permissions.experts.allow).toEqual([])
  })

  it('NACL union: child + base merge with deny precedence', async () => {
    await write(
      '_base',
      `id: _base
default_model: local-fast
default_skills:
  - system/filesystem
  - system/memory
permissions:
  skills:
    allow: [system/*]
    deny: [system/shell]
  experts:
    allow: [opus-4.7]
`,
    )
    await write(
      'researcher',
      `id: researcher
extends: _base
default_skills:
  - system/filesystem
  - research/web-deep-dive
permissions:
  skills:
    allow: [research/*]
    deny: [research/dangerous]
  experts:
    allow: [deepseek-v4]
`,
    )
    const p = await loadAgentProfile(dir, 'researcher')
    expect(p.defaultModel).toBe('local-fast')
    expect(p.defaultSkills).toEqual(['system/filesystem', 'research/web-deep-dive'])
    expect(p.permissions.skills.allow.sort()).toEqual(['research/*', 'system/*'])
    expect(p.permissions.skills.deny.sort()).toEqual(
      ['research/dangerous', 'system/shell'].sort(),
    )
    expect(p.permissions.experts.allow.sort()).toEqual(['deepseek-v4', 'opus-4.7'])
  })

  it('inherits defaults from base when child omits them', async () => {
    await write(
      '_base',
      `id: _base
default_model: local-fast
default_skills:
  - system/filesystem
permissions:
  skills:
    allow: [system/*]
`,
    )
    await write('child', `id: child\nextends: _base\n`)
    const p = await loadAgentProfile(dir, 'child')
    expect(p.defaultSkills).toEqual(['system/filesystem'])
    expect(p.permissions.skills.allow).toEqual(['system/*'])
  })

  it('rejects multi-level extends', async () => {
    await write('grandparent', `id: grandparent\ndefault_model: local-fast\n`)
    await write('parent', `id: parent\nextends: grandparent\n`)
    await write('child', `id: child\nextends: parent\n`)
    await expect(loadAgentProfile(dir, 'child')).rejects.toMatchObject({
      code: 'INVALID',
    })
  })

  it('rejects self-extends', async () => {
    await write('selfish', `id: selfish\nextends: selfish\ndefault_model: x\n`)
    await expect(loadAgentProfile(dir, 'selfish')).rejects.toMatchObject({
      code: 'CIRCULAR_EXTENDS',
    })
  })

  it('reports NOT_FOUND for missing file', async () => {
    await expect(loadAgentProfile(dir, 'missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('reports EXTENDS_NOT_FOUND when base is missing', async () => {
    await write('child', `id: child\nextends: missing\ndefault_model: x\n`)
    await expect(loadAgentProfile(dir, 'child')).rejects.toMatchObject({
      code: 'EXTENDS_NOT_FOUND',
    })
  })

  it('passive_recall defaults to disabled when absent', async () => {
    await write('_base', `id: _base\ndefault_model: local-fast\n`)
    const p = await loadAgentProfile(dir, '_base')
    expect(p.passiveRecall).toEqual({
      enabled: false,
      wikiHits: 2,
      historyHits: 2,
      maxCharsPerHit: 240,
    })
  })

  it('passive_recall: child block fully replaces base block when present', async () => {
    await write(
      '_base',
      `id: _base
default_model: local-fast
passive_recall:
  enabled: false
  wiki_hits: 1
`,
    )
    await write(
      'child',
      `id: child
extends: _base
passive_recall:
  enabled: true
  wiki_hits: 4
  history_hits: 3
`,
    )
    const p = await loadAgentProfile(dir, 'child')
    expect(p.passiveRecall.enabled).toBe(true)
    expect(p.passiveRecall.wikiHits).toBe(4)
    expect(p.passiveRecall.historyHits).toBe(3)
  })

  it('auto_distill: defaults to disabled with 30-min idle / 5-min scan / 0-day retention', async () => {
    await write('_base', `id: _base\ndefault_model: local-fast\n`)
    const p = await loadAgentProfile(dir, '_base')
    expect(p.autoDistill).toEqual({
      enabled: false,
      idleMinutes: 30,
      scanIntervalMinutes: 5,
      draftsMaxAgeDays: 0,
    })
  })

  it('auto_distill: derives scan interval as idle/6 (clamped to 1..30)', async () => {
    await write(
      'a',
      `id: a
default_model: local-fast
auto_distill:
  enabled: true
  idle_minutes: 60
`,
    )
    const p = await loadAgentProfile(dir, 'a')
    expect(p.autoDistill.scanIntervalMinutes).toBe(10) // 60/6
  })

  it('auto_distill: drafts_max_age_days defaults to 0 (disabled) and round-trips when set', async () => {
    await write('off', `id: off\ndefault_model: m\nauto_distill:\n  enabled: true\n`)
    const offProfile = await loadAgentProfile(dir, 'off')
    expect(offProfile.autoDistill.draftsMaxAgeDays).toBe(0)

    await write(
      'on',
      `id: on
default_model: m
auto_distill:
  enabled: true
  drafts_max_age_days: 30
`,
    )
    const onProfile = await loadAgentProfile(dir, 'on')
    expect(onProfile.autoDistill.draftsMaxAgeDays).toBe(30)
  })

  it('auto_distill: respects an explicit scan_interval_minutes', async () => {
    await write(
      'a',
      `id: a
default_model: local-fast
auto_distill:
  enabled: true
  idle_minutes: 60
  scan_interval_minutes: 2
`,
    )
    const p = await loadAgentProfile(dir, 'a')
    expect(p.autoDistill.scanIntervalMinutes).toBe(2)
  })

  it('deny_tools: defaults to empty list when absent', async () => {
    await write('_base', `id: _base\ndefault_model: local-fast\n`)
    const p = await loadAgentProfile(dir, '_base')
    expect(p.denyTools).toEqual([])
  })

  it('deny_tools: child + base lists are union-merged (stack only, no un-deny)', async () => {
    await write(
      '_base',
      `id: _base
default_model: local-fast
deny_tools:
  - shell_*
`,
    )
    await write(
      'child',
      `id: child
extends: _base
deny_tools:
  - consult_expert
`,
    )
    const p = await loadAgentProfile(dir, 'child')
    expect(p.denyTools.sort()).toEqual(['consult_expert', 'shell_*'])
  })

  it('passive_recall: child inherits the base block when omitted', async () => {
    await write(
      '_base',
      `id: _base
default_model: local-fast
passive_recall:
  enabled: true
  wiki_hits: 5
`,
    )
    await write('child', `id: child\nextends: _base\n`)
    const p = await loadAgentProfile(dir, 'child')
    expect(p.passiveRecall.enabled).toBe(true)
    expect(p.passiveRecall.wikiHits).toBe(5)
  })
})

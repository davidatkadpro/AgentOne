import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import { loadSkillIndex } from '@/skills/loader.js'
import { createProjectsService, type ProjectsService } from '../modules/projects/src/service.js'
import {
  createProposalsService,
  type ProposalsService,
} from '../modules/proposals/src/service.js'
import {
  parameters as createEstimateParams,
  handler as createEstimateHandler,
} from '../modules/proposals/skills/build-estimate/tools/create-estimate.js'
import {
  parameters as listEstimatesParams,
  handler as listEstimatesHandler,
} from '../modules/proposals/skills/generate-proposal/tools/list-estimates-for-project.js'
import type { ToolContext } from '@/skills/tool.js'

const REPO = process.cwd()

describe('modules/proposals/skills — loader discovery', () => {
  it('discovers build-estimate and generate-proposal via moduleSkillRoots', async () => {
    const idx = await loadSkillIndex({
      root: join(REPO, 'skills'),
      moduleSkillRoots: [
        { module: 'proposals', root: join(REPO, 'modules', 'proposals', 'skills') },
      ],
    })
    expect(idx.skills.get('proposals/build-estimate')).toBeDefined()
    expect(idx.skills.get('proposals/generate-proposal')).toBeDefined()
    const build = idx.skills.get('proposals/build-estimate')
    expect(build?.frontmatter.tools?.map((t) => t.id)).toEqual(['create_estimate'])
    const gen = idx.skills.get('proposals/generate-proposal')
    expect(gen?.frontmatter.tools?.map((t) => t.id).sort()).toEqual([
      'create_proposal',
      'list_estimates_for_project',
    ])
  })

  it('slash commands /build-estimate and /generate-proposal are registered', async () => {
    const idx = await loadSkillIndex({
      root: join(REPO, 'skills'),
      moduleSkillRoots: [
        { module: 'proposals', root: join(REPO, 'modules', 'proposals', 'skills') },
      ],
    })
    expect(idx.bySlashCommand.get('build-estimate')?.qualifiedName).toBe(
      'proposals/build-estimate',
    )
    expect(idx.bySlashCommand.get('generate-proposal')?.qualifiedName).toBe(
      'proposals/generate-proposal',
    )
    expect(idx.bySlashCommand.get('explain-estimate')?.qualifiedName).toBe(
      'proposals/explain-estimate',
    )
  })

  it('explain-estimate ships as an ask_agent-only walkthrough', async () => {
    const idx = await loadSkillIndex({
      root: join(REPO, 'skills'),
      moduleSkillRoots: [
        { module: 'proposals', root: join(REPO, 'modules', 'proposals', 'skills') },
      ],
    })
    const skill = idx.skills.get('proposals/explain-estimate')
    expect(skill).toBeDefined()
    expect(skill?.frontmatter.surface).toBe('ask_agent')
    // No tool wiring — read-only prompt walkthrough.
    expect(skill?.frontmatter.tools).toBeUndefined()
  })
})

interface Harness {
  db: Db
  projects: ProjectsService
  proposals: ProposalsService
  ctx: ToolContext
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  applyAllMigrationsForModule(db, 'proposals')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const projects = createProjectsService({ db, eventBus: bus, audit })
  const proposals = createProposalsService({ db, eventBus: bus, audit })
  const ctx = {
    sessionId: 'test',
    agentProfile: 'ops',
    permissions: undefined as never,
    expertSpend: undefined as never,
    services: {
      modules: {
        get: (name: string) =>
          name === 'proposals'
            ? {
                name: 'proposals',
                manifest: undefined as never,
                rootPath: '',
                status: 'active',
                service: proposals,
              }
            : undefined,
        getActiveService: <T>(name: string): T | undefined =>
          name === 'proposals' ? (proposals as unknown as T) : undefined,
        list: () => [],
      },
    } as never,
  } satisfies ToolContext
  return { db, projects, proposals, ctx }
}

describe('build-estimate / create_estimate tool', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('creates a draft estimate from kebab-case args and returns total', async () => {
    const project = h.projects.createProject(
      { number: '25001', name: 'Riverside' },
      { actor: { type: 'user' } },
    )
    const args = createEstimateParams.parse({
      project_id: project.id,
      source_scope_path: 'projects/25001 - Riverside/in/250523 - rfi/scope.md',
      notes: 'Built from scope.md',
      lines: [
        { kind: 'fixed', description: 'Permit drawings', qty: 1, unit_price: 4500 },
        {
          kind: 'time_and_materials',
          description: 'Site visits',
          qty: 8,
          unit: 'hr',
          unit_price: 165,
        },
      ],
    })
    const result = await createEstimateHandler(args, h.ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({
        project_id: project.id,
        status: 'draft',
        line_count: 2,
        total: 4500 + 8 * 165,
      })
    }
  })

  it('returns TOOL_VALIDATION for an unknown project (FK violation)', async () => {
    const args = createEstimateParams.parse({
      project_id: 'no-such-project',
      lines: [{ description: 'x' }],
    })
    const result = await createEstimateHandler(args, h.ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('TOOL_VALIDATION')
  })
})

describe('generate-proposal / list_estimates_for_project tool', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('returns estimates with computed totals', async () => {
    const project = h.projects.createProject(
      { number: '25001', name: 'Riverside' },
      { actor: { type: 'user' } },
    )
    h.proposals.createEstimate(
      {
        projectId: project.id,
        lines: [{ kind: 'fixed', description: 'a', qty: 1, unitPrice: 100 }],
      },
      { actor: { type: 'user' } },
    )
    const result = await listEstimatesHandler(
      listEstimatesParams.parse({ project_id: project.id }),
      h.ctx,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const list = (result.value as { estimates: Array<{ total: number }> }).estimates
      expect(list).toHaveLength(1)
      expect(list[0].total).toBe(100)
    }
  })
})

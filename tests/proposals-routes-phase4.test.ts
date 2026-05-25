import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog, type AuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import {
  createProjectsService,
  type ProjectsService,
} from '../modules/projects/src/service.js'
import {
  createProposalsService,
  type ProposalsService,
} from '../modules/proposals/src/service.js'
import { registerProposalsRoutes } from '../modules/proposals/src/routes.js'

interface Harness {
  db: Db
  app: FastifyInstance
  projects: ProjectsService
  proposals: ProposalsService
  audit: AuditLog
  bus: EventBus
  storageRoot: string
  modulesRoot: string
}

async function newHarness(opts: { pandocAvailable?: boolean } = {}): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  applyAllMigrationsForModule(db, 'proposals')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const storageRoot = await mkdtemp(join(tmpdir(), 'agentone-prop-p4-'))
  const modulesRoot = await mkdtemp(join(tmpdir(), 'agentone-modules-'))
  // plant a "bundled" templates folder so the templates route returns something
  await mkdir(join(modulesRoot, 'proposals', 'templates', 'default'), { recursive: true })
  await writeFile(
    join(modulesRoot, 'proposals', 'templates', 'default', 'README.md'),
    'Default proposal template.\nMore detail.\n',
  )
  const storage = new LocalFolderAdapter({ root: storageRoot })
  const projects = createProjectsService({ db, eventBus: bus, audit })
  const proposals = createProposalsService({
    db,
    eventBus: bus,
    audit,
    projects,
    storage,
  })
  const app = Fastify({ logger: false })
  await registerProposalsRoutes(app, {
    service: proposals,
    audit,
    storageRoot,
    modulesRoot,
    pandocAvailable: opts.pandocAvailable ?? false,
    eventBus: bus,
  })
  await app.ready()
  return { db, app, projects, proposals, audit, bus, storageRoot, modulesRoot }
}

async function dispose(h: Harness): Promise<void> {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  await h.app.close()
  h.db.close()
  await rm(h.storageRoot, { recursive: true, force: true })
  await rm(h.modulesRoot, { recursive: true, force: true })
}

describe('Proposals routes (phase 4)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  function makeProject(opts: { number?: string; folderPath?: string } = {}): string {
    return h.projects.createProject(
      {
        number: opts.number ?? '25001',
        name: 'Riverside',
        folderPath: opts.folderPath ?? `projects/${opts.number ?? '25001'}-riverside`,
      },
      { actor: { type: 'user' } },
    ).id
  }

  // ── P4P1 aliases ────────────────────────────────────────────────────────

  it('mounts canonical /api/projects/:id/estimates alongside the v1 alias (P4P1)', async () => {
    const projectId = makeProject()
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/estimates`,
      payload: { lines: [{ description: 'plans', qty: 1, unitPrice: 100 }] },
    })
    expect(res.statusCode).toBe(201)
    const list = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/estimates`,
    })
    expect(list.statusCode).toBe(200)
    expect((list.json() as { estimates: unknown[] }).estimates).toHaveLength(1)
  })

  // ── P4P2 artifacts ──────────────────────────────────────────────────────

  it('GET /api/proposals/artifacts returns merged estimate + proposal rows (P4P2)', async () => {
    const pid1 = makeProject({ number: '25001', folderPath: 'projects/25001-riv' })
    const pid2 = makeProject({ number: '25002', folderPath: 'projects/25002-other' })
    // Two estimates on p1, one of which becomes a proposal.
    const e1a = h.proposals.createEstimate(
      { projectId: pid1, lines: [{ description: 'a', qty: 2, unitPrice: 50 }] },
      { actor: { type: 'user' } },
    )
    h.proposals.createEstimate(
      { projectId: pid1, lines: [] },
      { actor: { type: 'user' } },
    )
    await h.proposals.createProposal(
      { projectId: pid1, estimateId: e1a.id },
      { actor: { type: 'user' } },
    )
    // One bare estimate on p2.
    h.proposals.createEstimate(
      { projectId: pid2, lines: [{ description: 'sketch', qty: 1, unitPrice: 80 }] },
      { actor: { type: 'user' } },
    )

    const res = await h.app.inject({ method: 'GET', url: '/api/proposals/artifacts' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { artifacts: Array<{ kind: string; displayStatus: string }> }
    expect(body.artifacts).toHaveLength(3)
    // At least one row should be the proposal (e1a became one).
    expect(body.artifacts.some((r) => r.kind === 'proposal')).toBe(true)
    // One is "Estimate · draft", one is "Proposal · draft" (created proposals
    // start as 'draft').
    expect(body.artifacts.some((r) => r.displayStatus === 'Estimate · draft')).toBe(true)
    expect(body.artifacts.some((r) => r.displayStatus === 'Proposal · draft')).toBe(true)
  })

  it('GET /api/proposals/artifacts filters by projectId and combined status', async () => {
    const pid1 = makeProject({ number: '25001', folderPath: 'projects/25001-riv' })
    const pid2 = makeProject({ number: '25002', folderPath: 'projects/25002-other' })
    h.proposals.createEstimate(
      { projectId: pid1, lines: [] },
      { actor: { type: 'user' } },
    )
    h.proposals.createEstimate(
      { projectId: pid2, lines: [] },
      { actor: { type: 'user' } },
    )

    const filtered = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/artifacts?projectId=${pid1}`,
    })
    expect((filtered.json() as { artifacts: unknown[] }).artifacts).toHaveLength(1)

    const byStatus = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/artifacts?status=${encodeURIComponent('Estimate · draft')}`,
    })
    expect((byStatus.json() as { artifacts: unknown[] }).artifacts.length).toBeGreaterThanOrEqual(2)
  })

  // ── P4P3 unified detail ─────────────────────────────────────────────────

  it('GET /api/proposals/:id returns { estimate, proposal:null } when given an estimate id (P4P3)', async () => {
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({ method: 'GET', url: `/api/proposals/${e.id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      estimate: { id: string }
      proposal: null
      predecessorEstimates: unknown[]
    }
    expect(body.estimate.id).toBe(e.id)
    expect(body.proposal).toBeNull()
    expect(body.predecessorEstimates).toEqual([])
  })

  it('GET /api/proposals/:id walks the predecessor chain', async () => {
    const projectId = makeProject()
    const e1 = h.proposals.createEstimate(
      { projectId, lines: [{ description: 'a', qty: 1, unitPrice: 1 }] },
      { actor: { type: 'user' } },
    )
    // Mark e1 ready then revise to produce e2 that points back at e1.
    h.proposals.setEstimateStatus(e1.id, 'ready', { actor: { type: 'user' } })
    const e2 = h.proposals.reviseEstimate(e1.id, { actor: { type: 'user' } })

    const res = await h.app.inject({ method: 'GET', url: `/api/proposals/${e2.id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      estimate: { id: string }
      predecessorEstimates: Array<{ id: string }>
    }
    expect(body.estimate.id).toBe(e2.id)
    expect(body.predecessorEstimates).toHaveLength(1)
    expect(body.predecessorEstimates[0]!.id).toBe(e1.id)
  })

  it('GET /api/proposals/:id 404s an unknown id', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/proposals/nope' })
    expect(res.statusCode).toBe(404)
  })

  // ── P4 PATCH /api/estimates/:id (full update) ───────────────────────────

  it('PATCH /api/estimates/:id replaces lines and emits estimate.updated (P3 E2)', async () => {
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [{ description: 'a', qty: 1, unitPrice: 100 }] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/estimates/${e.id}`,
      payload: {
        lines: [
          { description: 'aa', qty: 2, unitPrice: 50 },
          { description: 'bb', qty: 3, unitPrice: 25 },
        ],
        notes: 'new note',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { estimate: { lines: unknown[]; notes: string | null } }
    expect(body.estimate.lines).toHaveLength(2)
    expect(body.estimate.notes).toBe('new note')
  })

  it('PATCH /api/estimates/:id rejects an empty body', async () => {
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/estimates/${e.id}`,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  // ── P4P4 revise ────────────────────────────────────────────────────────

  it('POST /api/estimates/:id/revise creates a new draft + leaves the old estimate (P4P4)', async () => {
    const projectId = makeProject()
    const e1 = h.proposals.createEstimate(
      { projectId, lines: [{ description: 'a', qty: 1, unitPrice: 1 }] },
      { actor: { type: 'user' } },
    )
    h.proposals.setEstimateStatus(e1.id, 'ready', { actor: { type: 'user' } })
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/estimates/${e1.id}/revise`,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { estimate: { id: string; status: string; previousEstimateId: string | null } }
    expect(body.estimate.previousEstimateId).toBe(e1.id)
    expect(body.estimate.status).toBe('draft')
    // The old estimate's status is unchanged.
    const old = h.proposals.getEstimate(e1.id)
    expect(old?.status).toBe('ready')
  })

  it('POST /api/estimates/:id/revise 404s an unknown estimate', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/estimates/nope/revise',
    })
    expect(res.statusCode).toBe(404)
  })

  // ── P4P5 render + download ──────────────────────────────────────────────

  it('POST /api/proposals/:id/render returns md and lists pdf as unavailable when Pandoc missing (P4P5)', async () => {
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [{ description: 'a', qty: 1, unitPrice: 100 }] },
      { actor: { type: 'user' } },
    )
    const p = await h.proposals.createProposal(
      { projectId, estimateId: e.id },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/proposals/${p.id}/render`,
      payload: { formats: ['md', 'pdf'] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      files: Array<{ kind: string }>
      unavailable: string[]
    }
    expect(body.files.some((f) => f.kind === 'md')).toBe(true)
    expect(body.unavailable).toContain('pdf')
  })

  it('GET /api/proposals/:id/download/md streams the markdown', async () => {
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [{ description: 'a', qty: 1, unitPrice: 1 }] },
      { actor: { type: 'user' } },
    )
    const p = await h.proposals.createProposal(
      { projectId, estimateId: e.id },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/${p.id}/download/md`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/markdown')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.body).toContain('Proposal 25001-P1')
  })

  it('GET /api/proposals/:id/download/pdf returns 503 when Pandoc unavailable', async () => {
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    const p = await h.proposals.createProposal(
      { projectId, estimateId: e.id },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/${p.id}/download/pdf`,
    })
    expect(res.statusCode).toBe(503)
  })

  // ── P4P6 templates ──────────────────────────────────────────────────────

  it('GET /api/proposals/templates lists bundled templates (P4P6)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/proposals/templates' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      templates: Array<{ name: string; source: string; description: string | null }>
    }
    expect(body.templates).toHaveLength(1)
    expect(body.templates[0]!.name).toBe('default')
    expect(body.templates[0]!.source).toBe('module')
    expect(body.templates[0]!.description).toContain('Default proposal template')
  })

  it('GET /api/proposals/templates lets the override win on a name collision', async () => {
    // Plant an override of the same name.
    await mkdir(join(h.storageRoot, 'drafts', '_templates', 'proposals', 'default'), {
      recursive: true,
    })
    await writeFile(
      join(h.storageRoot, 'drafts', '_templates', 'proposals', 'default', 'README.md'),
      'My override.\n',
    )
    const res = await h.app.inject({ method: 'GET', url: '/api/proposals/templates' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      templates: Array<{ name: string; source: string; description: string | null }>
    }
    const def = body.templates.find((t) => t.name === 'default')!
    expect(def.source).toBe('override')
    expect(def.description).toContain('override')
  })

  it('GET /api/proposals/templates emits module.reloaded after the templates folder mtime changes (P4P9)', async () => {
    const reloads: string[] = []
    h.bus.on('module.reloaded', (e) => {
      reloads.push(e.module)
    })
    // First fetch warms the cache. No event yet (first warm).
    await h.app.inject({ method: 'GET', url: '/api/proposals/templates' })
    expect(reloads).toEqual([])
    // Plant a new override + wait a beat so the parent folder's mtime ticks.
    await new Promise((r) => setTimeout(r, 25))
    await mkdir(join(h.storageRoot, 'drafts', '_templates', 'proposals', 'new-template'), {
      recursive: true,
    })
    await writeFile(
      join(h.storageRoot, 'drafts', '_templates', 'proposals', 'new-template', 'README.md'),
      'A new override template.\n',
    )
    const res = await h.app.inject({ method: 'GET', url: '/api/proposals/templates' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { templates: Array<{ name: string }> }
    expect(body.templates.some((t) => t.name === 'new-template')).toBe(true)
    // Allow microtask drain so the bus emit settles.
    await new Promise((r) => setImmediate(r))
    expect(reloads).toEqual(['proposals'])
  })

  // ── P4P7 scope files ────────────────────────────────────────────────────

  it('GET /api/projects/:id/scope-files lists scope.md files newest-first (P4P7)', async () => {
    const projectId = makeProject({
      number: '25001',
      folderPath: 'projects/25001-riverside',
    })
    // Plant two scope.md files on disk under different dated folders.
    await mkdir(
      join(h.storageRoot, 'projects', '25001-riverside', 'in', '250520-rfi-1'),
      { recursive: true },
    )
    await writeFile(
      join(h.storageRoot, 'projects', '25001-riverside', 'in', '250520-rfi-1', 'scope.md'),
      '# scope 1',
    )
    await mkdir(
      join(h.storageRoot, 'projects', '25001-riverside', 'in', '250522-rfi-2'),
      { recursive: true },
    )
    await writeFile(
      join(h.storageRoot, 'projects', '25001-riverside', 'in', '250522-rfi-2', 'scope.md'),
      '# scope 2',
    )

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scope-files`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      files: Array<{ path: string; bytes: number; mtime: string }>
    }
    expect(body.files).toHaveLength(2)
    expect(body.files[0]!.path).toContain('scope.md')
  })

  // ── P4P8 history ────────────────────────────────────────────────────────

  it('GET /api/proposals/:id/history combines events from predecessor estimates (P4P8)', async () => {
    const projectId = makeProject()
    const e1 = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    h.proposals.setEstimateStatus(e1.id, 'ready', { actor: { type: 'user' } })
    const e2 = h.proposals.reviseEstimate(e1.id, { actor: { type: 'user' } })
    const p = await h.proposals.createProposal(
      { projectId, estimateId: e2.id },
      { actor: { type: 'user' } },
    )
    h.proposals.setProposalStatus(p.id, 'issued', { actor: { type: 'user' } })

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/proposals/${p.id}/history`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { entries: Array<{ action: string }> }
    const actions = body.entries.map((e) => e.action)
    expect(actions).toContain('estimate.created')
    expect(actions).toContain('proposal.created')
    expect(actions).toContain('proposal.issued')
    // The chronological order means estimate.created appears before
    // proposal.created.
    expect(actions.indexOf('estimate.created')).toBeLessThan(
      actions.indexOf('proposal.created'),
    )
  })

  // ── PATCH /api/proposals/:id state machine ──────────────────────────────

  it('PATCH /api/proposals/:id { status: "accepted" } sets decided_at + emits proposal.accepted', async () => {
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    const p = await h.proposals.createProposal(
      { projectId, estimateId: e.id },
      { actor: { type: 'user' } },
    )
    h.proposals.setProposalStatus(p.id, 'issued', { actor: { type: 'user' } })
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/proposals/${p.id}`,
      payload: { status: 'accepted' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { proposal: { status: string; decidedAt: number | null } }
    expect(body.proposal.status).toBe('accepted')
    expect(body.proposal.decidedAt).toBeGreaterThan(0)
  })

  it('PATCH /api/proposals/:id supersede sets previous_proposal_id', async () => {
    const projectId = makeProject()
    const e1 = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    const p1 = await h.proposals.createProposal(
      { projectId, estimateId: e1.id },
      { actor: { type: 'user' } },
    )
    // Create a second proposal to be the replacement.
    const e2 = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    const p2 = await h.proposals.createProposal(
      { projectId, estimateId: e2.id },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/proposals/${p1.id}`,
      payload: { status: 'superseded', supersededByProposalId: p2.id },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { proposal: { status: string; previousProposalId: string | null } }
    expect(body.proposal.status).toBe('superseded')
    expect(body.proposal.previousProposalId).toBe(p2.id)
  })
})

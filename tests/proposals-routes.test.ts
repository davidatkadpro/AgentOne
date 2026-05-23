import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
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
  storageRoot: string
}

async function newHarness(): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyModuleMigrations(db, 'projects', [
    {
      version: 1,
      name: '001_init',
      sql: readFileSync(
        join(process.cwd(), 'modules', 'projects', 'schema', '001_init.sql'),
        'utf-8',
      ),
    },
  ])
  applyModuleMigrations(db, 'proposals', [
    {
      version: 1,
      name: '001_init',
      sql: readFileSync(
        join(process.cwd(), 'modules', 'proposals', 'schema', '001_init.sql'),
        'utf-8',
      ),
    },
  ])
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const storageRoot = await mkdtemp(join(tmpdir(), 'agentone-prop-routes-'))
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
  await registerProposalsRoutes(app, { service: proposals })
  await app.ready()
  return { db, app, projects, proposals, storageRoot }
}

async function dispose(h: Harness): Promise<void> {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  await h.app.close()
  h.db.close()
  await rm(h.storageRoot, { recursive: true, force: true })
}

describe('Proposals routes', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  function makeProject(): string {
    return h.projects.createProject(
      { number: '25001', name: 'Riverside' },
      { actor: { type: 'user' } },
    ).id
  }

  it('POST /api/v1/projects/:id/estimates creates an estimate (201)', async () => {
    const projectId = makeProject()
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/estimates`,
      payload: {
        notes: 'first cut',
        lines: [{ kind: 'fixed', description: 'plans', qty: 1, unitPrice: 4500 }],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { estimate: { id: string; lines: unknown[] } }
    expect(body.estimate.id).toBeTruthy()
    expect(body.estimate.lines).toHaveLength(1)
  })

  it('GET /api/v1/projects/:id/estimates lists rows', async () => {
    const projectId = makeProject()
    h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/estimates`,
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { estimates: unknown[] }).estimates).toHaveLength(1)
  })

  it('GET /api/v1/estimates/:id returns 404 on unknown', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/estimates/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH /api/v1/estimates/:id/status flips status', async () => {
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/estimates/${e.id}/status`,
      payload: { status: 'ready' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { estimate: { status: string } }
    expect(body.estimate.status).toBe('ready')
  })

  it('POST /api/v1/projects/:id/proposals returns 201 with rendered path', async () => {
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      {
        projectId,
        lines: [{ kind: 'fixed', description: 'plans', qty: 1, unitPrice: 4500 }],
      },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/proposals`,
      payload: { estimateId: e.id },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { proposal: { number: string; renderedMarkdownPath: string } }
    expect(body.proposal.number).toBe('25001-P1')
    expect(body.proposal.renderedMarkdownPath).toContain('drafts/proposals/25001-P1.md')
  })

  it('GET /api/v1/projects/:id/proposals lists', async () => {
    const projectId = makeProject()
    const e = h.proposals.createEstimate(
      { projectId, lines: [] },
      { actor: { type: 'user' } },
    )
    await h.proposals.createProposal(
      { projectId, estimateId: e.id },
      { actor: { type: 'user' } },
    )
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/proposals`,
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { proposals: unknown[] }).proposals).toHaveLength(1)
  })

  it('PATCH /api/v1/proposals/:id/status to "issued" stamps issued_at', async () => {
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
      method: 'PATCH',
      url: `/api/v1/proposals/${p.id}/status`,
      payload: { status: 'issued' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { proposal: { status: string; issuedAt: number | null } }
    expect(body.proposal.status).toBe('issued')
    expect(body.proposal.issuedAt).toBeGreaterThan(0)
  })
})

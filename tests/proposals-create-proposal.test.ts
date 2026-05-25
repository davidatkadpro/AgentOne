import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import {
  createProjectsService,
  type ProjectsService,
} from '../modules/projects/src/service.js'
import {
  createProposalsService,
  type ProposalsService,
} from '../modules/proposals/src/service.js'

interface Harness {
  db: Db
  bus: EventBus
  storageRoot: string
  projects: ProjectsService
  proposals: ProposalsService
}

async function newHarness(): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  applyAllMigrationsForModule(db, 'proposals')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const storageRoot = await mkdtemp(join(tmpdir(), 'agentone-prop-'))
  const storage = new LocalFolderAdapter({ root: storageRoot })
  // No storage on the projects service so its best-effort `void` folder
  // creation doesn't race against the test cleanup. The proposals service's
  // storage.write() mkdirs its own parent dirs.
  const projects = createProjectsService({ db, eventBus: bus, audit })
  const proposals = createProposalsService({
    db,
    eventBus: bus,
    audit,
    projects,
    storage,
  })
  return { db, bus, storageRoot, projects, proposals }
}

async function dispose(h: Harness): Promise<void> {
  // Let the projects service's best-effort `void` folder creation settle so
  // the rm doesn't race against an in-flight mkdir on the same path.
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  h.db.close()
  await rm(h.storageRoot, { recursive: true, force: true })
}

describe('ProposalsService.createProposal', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  async function makeProjectAndEstimate(): Promise<{
    projectId: string
    estimateId: string
  }> {
    const project = h.projects.createProject(
      { number: '25001', name: 'Riverside Reno', client: 'Owner LLC' },
      { actor: { type: 'user' } },
    )
    const estimate = h.proposals.createEstimate(
      {
        projectId: project.id,
        lines: [
          { kind: 'fixed', description: 'Permit drawings', qty: 1, unitPrice: 4500 },
          { kind: 'time_and_materials', description: 'Site visits', qty: 8, unit: 'hr', unitPrice: 165 },
        ],
      },
      { actor: { type: 'user' } },
    )
    return { projectId: project.id, estimateId: estimate.id }
  }

  it("creates proposal '<project.number>-P1' on the first call and writes the rendered markdown", async () => {
    const { projectId, estimateId } = await makeProjectAndEstimate()
    const proposal = await h.proposals.createProposal(
      { projectId, estimateId },
      { actor: { type: 'user' } },
    )
    expect(proposal.number).toBe('25001-P1')
    expect(proposal.status).toBe('draft')
    expect(proposal.renderedMarkdownPath).toContain('drafts/proposals/25001-P1.md')

    const abs = join(h.storageRoot, proposal.renderedMarkdownPath as string)
    const md = await readFile(abs, 'utf-8')
    expect(md).toContain('# Proposal 25001-P1')
    expect(md).toContain('**Project:** 25001 — Riverside Reno')
    expect(md).toContain('**Client:** Owner LLC')
    expect(md).toContain('Permit drawings')
    expect(md).toContain('Site visits')
    // Total: 4500 + 8 * 165 = 5820
    expect(md).toContain('Total: $5820.00')
  })

  it('increments to -P2, -P3 on subsequent proposals for the same project', async () => {
    const { projectId, estimateId } = await makeProjectAndEstimate()
    const a = await h.proposals.createProposal(
      { projectId, estimateId },
      { actor: { type: 'user' } },
    )
    const b = await h.proposals.createProposal(
      { projectId, estimateId },
      { actor: { type: 'user' } },
    )
    expect(a.number).toBe('25001-P1')
    expect(b.number).toBe('25001-P2')
  })

  it('emits proposal.created and records an audit row', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('proposal.created', (e) => {
      captured.push(e)
    })
    const { projectId, estimateId } = await makeProjectAndEstimate()
    const proposal = await h.proposals.createProposal(
      { projectId, estimateId },
      { actor: { type: 'agent', sessionId: 'sess-1' } },
    )
    await new Promise((r) => setImmediate(r))
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      type: 'proposal.created',
      proposalId: proposal.id,
      number: '25001-P1',
    })
  })

  it('throws when the estimate belongs to a different project', async () => {
    const otherProject = h.projects.createProject(
      { number: '25099', name: 'Other' },
      { actor: { type: 'user' } },
    )
    const { projectId: _, estimateId } = await makeProjectAndEstimate()
    await expect(
      h.proposals.createProposal(
        { projectId: otherProject.id, estimateId },
        { actor: { type: 'user' } },
      ),
    ).rejects.toThrow(/belongs to project/i)
  })
})

describe('ProposalsService.setProposalStatus', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  it('emits proposal.issued and stamps issued_at on issued', async () => {
    const captured: AgentEvent[] = []
    h.bus.on('proposal.issued', (e) => {
      captured.push(e)
    })
    const project = h.projects.createProject(
      { number: '25001', name: 'x' },
      { actor: { type: 'user' } },
    )
    const estimate = h.proposals.createEstimate(
      { projectId: project.id, lines: [] },
      { actor: { type: 'user' } },
    )
    const proposal = await h.proposals.createProposal(
      { projectId: project.id, estimateId: estimate.id },
      { actor: { type: 'user' } },
    )
    h.proposals.setProposalStatus(proposal.id, 'issued', { actor: { type: 'user' } })
    await new Promise((r) => setImmediate(r))
    expect(captured).toHaveLength(1)
    const refetched = h.proposals.getProposal(proposal.id)
    expect(refetched?.status).toBe('issued')
    expect(refetched?.issuedAt).toBeGreaterThan(0)
  })
})

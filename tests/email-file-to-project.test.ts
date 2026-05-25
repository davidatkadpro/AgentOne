import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import { createProjectsService } from '../modules/projects/src/service.js'
import { createEmailService, type EmailService } from '../modules/email/src/service.js'

interface Harness {
  db: Db
  bus: EventBus
  service: EmailService
  storageRoot: string
}

async function newHarness(): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  applyAllMigrationsForModule(db, 'email')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const storageRoot = await mkdtemp(join(tmpdir(), 'agentone-email-file-'))
  const storage = new LocalFolderAdapter({ root: storageRoot })
  const projects = createProjectsService({ db, eventBus: bus, audit, storage })
  const service = createEmailService({ db, eventBus: bus, audit, projects, storage })
  return { db, bus, service, storageRoot }
}

async function disposeHarness(h: Harness): Promise<void> {
  h.db.close()
  await rm(h.storageRoot, { recursive: true, force: true })
}

describe('EmailService.fileToProject', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await disposeHarness(h)
  })

  async function makeProject(): Promise<{ id: string; folderPath: string }> {
    // Use the projects service indirectly via the same db for realism.
    const stmt = h.db.prepare(
      `INSERT INTO project (id, number, name, status, folder_path, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, '{}', ?, ?)`,
    )
    const id = 'proj-1'
    const folderPath = 'projects/24001 - Riverside Reno'
    const now = Date.now()
    stmt.run(id, '24001', 'Riverside Reno', folderPath, now, now)
    return { id, folderPath }
  }

  it("creates <project>/in/<yymmdd> - <slug>/email.md with summary content and marks the email filed", async () => {
    const { id: projectId, folderPath } = await makeProject()
    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-100',
        receivedAt: Date.parse('2025-05-23T10:00:00Z'),
        fromAddress: 'owner@example.com',
        fromName: 'Riverside Owner',
        subject: 'RFI: bathroom fixtures',
        snippet: 'Quick question about the proposed fixture set...',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )

    const result = await h.service.fileToProject(
      {
        emailId: email.id,
        projectId,
        body: 'Hi — quick question about the proposed fixture set.\n\nCan we swap...',
      },
      { actor: { type: 'user' } },
    )

    expect(result.folderPath.startsWith(`${folderPath}/in/`)).toBe(true)
    expect(result.folderPath).toContain('250523')
    // Slug should sanitize the subject.
    expect(result.folderPath.toLowerCase()).toContain('rfi-bathroom-fixtures')

    const emailMdAbs = join(h.storageRoot, result.folderPath, 'email.md')
    const contents = await readFile(emailMdAbs, 'utf-8')
    expect(contents).toMatch(/^---\n/)
    expect(contents).toContain('from: "Riverside Owner <owner@example.com>"')
    expect(contents).toContain('subject: "RFI: bathroom fixtures"')
    expect(contents).toContain('# RFI: bathroom fixtures')
    expect(contents).toContain('Hi — quick question about the proposed fixture set.')

    const refreshed = h.service.getEmail(email.id)
    expect(refreshed?.filedProjectId).toBe(projectId)
    expect(refreshed?.filedFolderPath).toBe(result.folderPath)
  })

  it('writes attachments alongside email.md', async () => {
    const { id: projectId } = await makeProject()
    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-101',
        receivedAt: Date.parse('2025-05-23T10:00:00Z'),
        fromAddress: 'owner@example.com',
        subject: 'Plans + survey',
        hasAttachments: true,
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )

    const result = await h.service.fileToProject(
      {
        emailId: email.id,
        projectId,
        body: 'See attached.',
        attachments: [
          { filename: 'site-survey.pdf', content: Buffer.from('%PDF-1.4 fake survey') },
          { filename: 'sketch.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        ],
      },
      { actor: { type: 'user' } },
    )

    const pdf = await readFile(join(h.storageRoot, result.folderPath, 'site-survey.pdf'))
    expect(pdf.toString('utf-8')).toContain('%PDF-1.4')
    const png = await readFile(join(h.storageRoot, result.folderPath, 'sketch.png'))
    expect(png[0]).toBe(0x89)
    expect(png[3]).toBe(0x47)
  })

  it('emits email.filed and writes an audit row', async () => {
    const { id: projectId } = await makeProject()
    const captured: AgentEvent[] = []
    h.bus.on('email.filed', (e) => {
      captured.push(e)
    })

    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-102',
        receivedAt: Date.parse('2025-05-23T10:00:00Z'),
        fromAddress: 'a@b.com',
        subject: 'Hi',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    await h.service.fileToProject(
      { emailId: email.id, projectId, body: 'body' },
      { actor: { type: 'user' } },
    )
    await new Promise((r) => setImmediate(r))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      type: 'email.filed',
      emailId: email.id,
      projectId,
    })
  })

  it("uses 'email' as the slug when subject is missing", async () => {
    const { id: projectId } = await makeProject()
    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-103',
        receivedAt: Date.parse('2025-05-23T10:00:00Z'),
        fromAddress: 'a@b.com',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    const result = await h.service.fileToProject(
      { emailId: email.id, projectId, body: '' },
      { actor: { type: 'user' } },
    )
    expect(result.folderPath).toMatch(/\/in\/250523 - email$/)
  })

  it('throws when the email is already filed (idempotency guard)', async () => {
    const { id: projectId } = await makeProject()
    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-104',
        receivedAt: Date.parse('2025-05-23T10:00:00Z'),
        fromAddress: 'a@b.com',
        subject: 's',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    await h.service.fileToProject(
      { emailId: email.id, projectId, body: 'body' },
      { actor: { type: 'user' } },
    )
    await expect(
      h.service.fileToProject(
        { emailId: email.id, projectId, body: 'body' },
        { actor: { type: 'user' } },
      ),
    ).rejects.toThrow(/already filed/i)
  })

  it('throws when the project does not exist', async () => {
    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-105',
        receivedAt: Date.parse('2025-05-23T10:00:00Z'),
        fromAddress: 'a@b.com',
        subject: 's',
      },
      { actor: { type: 'scheduler', id: 'test-poll' } },
    )
    await expect(
      h.service.fileToProject(
        { emailId: email.id, projectId: 'no-such-project', body: 'body' },
        { actor: { type: 'user' } },
      ),
    ).rejects.toThrow(/project/i)
  })

  it('throws when the email does not exist', async () => {
    const { id: projectId } = await makeProject()
    await expect(
      h.service.fileToProject(
        { emailId: 'no-such-email', projectId, body: 'body' },
        { actor: { type: 'user' } },
      ),
    ).rejects.toThrow(/email/i)
  })
})

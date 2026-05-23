import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import { createProjectsService, type ProjectsService } from '../modules/projects/src/service.js'
import { createEmailService, type EmailService } from '../modules/email/src/service.js'
import {
  parameters as writeScopeParams,
  handler as writeScopeHandler,
} from '../modules/email/skills/scope-extractor/tools/write-scope-md.js'
import type { ToolContext } from '@/skills/tool.js'

interface Harness {
  db: Db
  projects: ProjectsService
  email: EmailService
  storageRoot: string
  storage: LocalFolderAdapter
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
  applyModuleMigrations(db, 'email', [
    {
      version: 1,
      name: '001_init',
      sql: readFileSync(
        join(process.cwd(), 'modules', 'email', 'schema', '001_init.sql'),
        'utf-8',
      ),
    },
  ])
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const storageRoot = await mkdtemp(join(tmpdir(), 'agentone-scope-'))
  const storage = new LocalFolderAdapter({ root: storageRoot })
  const projects = createProjectsService({ db, eventBus: bus, audit, storage })
  const email = createEmailService({ db, eventBus: bus, audit, projects, storage })
  return { db, projects, email, storageRoot, storage }
}

async function dispose(h: Harness): Promise<void> {
  h.db.close()
  await rm(h.storageRoot, { recursive: true, force: true })
}

function fakeCtx(h: Harness): ToolContext {
  return {
    sessionId: 'test',
    agentProfile: 'ops',
    permissions: undefined as never,
    expertSpend: undefined as never,
    services: {
      storage: h.storage,
      modules: {
        get: (name: string) => {
          if (name === 'email') {
            return {
              name: 'email',
              manifest: undefined as never,
              rootPath: '',
              status: 'active',
              service: h.email,
            }
          }
          if (name === 'projects') {
            return {
              name: 'projects',
              manifest: undefined as never,
              rootPath: '',
              status: 'active',
              service: h.projects,
            }
          }
          return undefined
        },
        list: () => [],
      },
    } as never,
  }
}

describe('write_scope_md', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  it("writes scope.md alongside the filed email and wraps YAML with fences", async () => {
    const project = h.projects.createProject(
      { number: '25001', name: 'Riverside Reno' },
      { actor: { type: 'user' } },
    )
    const email = h.email.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-scope',
        receivedAt: Date.parse('2025-05-23T10:00:00Z'),
        fromAddress: 'owner@example.com',
        subject: 'Project scope',
      },
      { actor: { type: 'scheduler', id: 'test' } },
    )
    await h.email.fileToProject(
      { emailId: email.id, projectId: project.id, body: 'trigger email' },
      { actor: { type: 'user' } },
    )
    const refreshed = h.email.getEmail(email.id)!
    expect(refreshed.filedFolderPath).toBeTruthy()

    const result = await writeScopeHandler(
      writeScopeParams.parse({
        email_id: email.id,
        frontmatter_yaml:
          'client: Owner LLC\nproject_type: renovation\nphases:\n  - design\n  - permit\nassumptions: []\nexclusions: []',
        body: '### Deliverables\n\nPermit drawings + construction set.',
      }),
      fakeCtx(h),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { path: string }
    const abs = join(h.storageRoot, value.path)
    const contents = await readFile(abs, 'utf-8')
    expect(contents).toMatch(/^---\n/)
    expect(contents).toContain('client: Owner LLC')
    expect(contents).toContain('### Deliverables')
  })

  it('refuses to write before the email is filed', async () => {
    const email = h.email.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-unfiled',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
        subject: 's',
      },
      { actor: { type: 'scheduler', id: 'test' } },
    )
    const result = await writeScopeHandler(
      writeScopeParams.parse({
        email_id: email.id,
        frontmatter_yaml: 'client: x',
        body: '### x',
      }),
      fakeCtx(h),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('TOOL_VALIDATION')
      expect(result.error.message).toMatch(/not been filed/i)
    }
  })

  it('returns TOOL_VALIDATION for an unknown email', async () => {
    const result = await writeScopeHandler(
      writeScopeParams.parse({
        email_id: 'no-such',
        frontmatter_yaml: 'client: x',
        body: '### x',
      }),
      fakeCtx(h),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('TOOL_VALIDATION')
  })
})

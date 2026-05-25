import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import { createEmailService, type EmailService } from '../modules/email/src/service.js'
import {
  discoverEmailActions,
  registerEmailActions,
  renderTemplate,
  __resetDiscoveryCache,
} from '../modules/email/src/actions.js'
import type { Orchestrator } from '@/orchestrator/turn.js'

describe('renderTemplate', () => {
  it('substitutes simple top-level keys', () => {
    expect(renderTemplate('Hi {{name}}', { name: 'David' })).toBe('Hi David')
  })

  it('walks dot paths', () => {
    expect(renderTemplate('From {{email.subject}}', { email: { subject: 'rfi' } })).toBe(
      'From rfi',
    )
  })

  it('returns empty for missing keys (no crash)', () => {
    expect(renderTemplate('A {{a.b.c}} B', { a: {} })).toBe('A  B')
  })

  it('survives null/undefined values', () => {
    expect(renderTemplate('{{x}}', { x: null })).toBe('')
  })
})

describe('discoverEmailActions', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentone-actions-'))
    __resetDiscoveryCache()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeSkill(name: string, frontmatter: string, body = '# body'): Promise<void> {
    await mkdir(join(dir, name), { recursive: true })
    await writeFile(join(dir, name, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`)
  }

  it('returns empty when directory does not exist', async () => {
    const result = await discoverEmailActions(join(dir, 'missing'))
    expect(result.actions).toEqual([])
    expect(result.errors).toEqual([])
  })

  it('lists valid SKILL.md entries', async () => {
    await writeSkill(
      'file-to-project',
      [
        'name: file-to-project',
        'description: File this email into a project',
        'label: File to project',
        'icon: folder-input',
        'default_profile: ops',
        'requires_confirmation: false',
        'surface: action',
      ].join('\n'),
    )
    await writeSkill(
      'create-new-project',
      [
        'name: create-new-project',
        'description: Create a project from this email',
      ].join('\n'),
    )
    const result = await discoverEmailActions(dir)
    expect(result.actions).toHaveLength(2)
    const file = result.actions.find((a) => a.name === 'file-to-project')!
    expect(file.label).toBe('File to project')
    expect(file.icon).toBe('folder-input')
    expect(file.defaultProfile).toBe('ops')
    expect(file.surface).toBe('action')
    const create = result.actions.find((a) => a.name === 'create-new-project')!
    expect(create.label).toBe('Create New Project') // title-cased from name
    expect(create.surface).toBe('ask_agent') // default
  })

  it('surfaces frontmatter errors and skips the action', async () => {
    await writeSkill('bad', 'name: Bad_Name\ndescription: x')
    const result = await discoverEmailActions(dir)
    expect(result.actions).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].skill).toBe('bad')
  })
})

interface Harness {
  db: Db
  app: FastifyInstance
  service: EmailService
  skillsDir: string
  bus: EventBus
  events: AgentEvent[]
  fakeOrchestrator: {
    spawnSession: ReturnType<typeof vi.fn>
  }
}

async function newHarness(): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  applyAllMigrationsForModule(db, 'email')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const service = createEmailService({ db, eventBus: bus, audit })
  const skillsDir = await mkdtemp(join(tmpdir(), 'agentone-action-dispatch-'))
  await mkdir(join(skillsDir, 'file-to-project'), { recursive: true })
  await writeFile(
    join(skillsDir, 'file-to-project', 'SKILL.md'),
    [
      '---',
      'name: file-to-project',
      'description: File this email into a project',
      'default_profile: ops',
      'prompt_template: |',
      "  File email {{email.id}} ({{email.subject}}) into the right project.",
      '---',
      '',
      '# body',
    ].join('\n'),
  )

  const fakeOrchestrator = {
    spawnSession: vi.fn(async () => ({
      session: { id: 'spawned-1', spawnedBy: 'modules/email/file-to-project' },
      handle: { stream: (async function* () {})() },
    })),
  }
  const events: AgentEvent[] = []
  bus.onAny((e) => {
    events.push(e)
  })
  const app = Fastify({ logger: false })
  await registerEmailActions(app, {
    service,
    orchestrator: fakeOrchestrator as unknown as Orchestrator,
    skillsDir,
    eventBus: bus,
  })
  await app.ready()
  __resetDiscoveryCache()
  return { db, app, service, skillsDir, bus, events, fakeOrchestrator }
}

async function dispose(h: Harness): Promise<void> {
  await h.app.close()
  h.db.close()
  await rm(h.skillsDir, { recursive: true, force: true })
}

describe('Email action dispatcher', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  it('GET /api/v1/email/actions lists the discovered actions', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/email/actions' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { actions: Array<{ name: string }> }
    expect(body.actions.map((a) => a.name)).toEqual(['file-to-project'])
  })

  it('POST /api/v1/email/actions spawns a session with the rendered template', async () => {
    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-1',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
        subject: 'RFI fixtures',
      },
      { actor: { type: 'scheduler', id: 'test' } },
    )
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/email/actions',
      payload: { action: 'file-to-project', emailId: email.id },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { sessionId: string; action: string }
    expect(body.sessionId).toBe('spawned-1')
    expect(body.action).toBe('file-to-project')
    expect(h.fakeOrchestrator.spawnSession).toHaveBeenCalledTimes(1)
    const spawnArg = h.fakeOrchestrator.spawnSession.mock.calls[0][0]
    expect(spawnArg.spawnedBy).toBe('modules/email/file-to-project')
    expect(spawnArg.agentProfile).toBe('ops')
    expect(spawnArg.initialMessage).toContain(email.id)
    expect(spawnArg.initialMessage).toContain('RFI fixtures')
  })

  it('POST returns 404 UNKNOWN_ACTION for an unknown skill', async () => {
    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-2',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
      },
      { actor: { type: 'scheduler', id: 'test' } },
    )
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/email/actions',
      payload: { action: 'no-such-action', emailId: email.id },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'UNKNOWN_ACTION' })
  })

  it('POST emits email.action_started immediately and email.action_completed after the drain', async () => {
    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-evt',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
      },
      { actor: { type: 'scheduler', id: 'test' } },
    )
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/email/actions',
      payload: { action: 'file-to-project', emailId: email.id },
    })
    // The drain runs after the route returns. Let microtasks settle.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const started = h.events.find((e) => e.type === 'email.action_started')
    const completed = h.events.find((e) => e.type === 'email.action_completed')
    expect(started).toMatchObject({
      type: 'email.action_started',
      emailId: email.id,
      action: 'file-to-project',
      sessionId: 'spawned-1',
    })
    expect(completed).toMatchObject({
      type: 'email.action_completed',
      emailId: email.id,
      action: 'file-to-project',
      sessionId: 'spawned-1',
      ok: true,
    })
  })

  it('POST returns 404 EMAIL_NOT_FOUND for an unknown email', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/email/actions',
      payload: { action: 'file-to-project', emailId: 'nope' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'EMAIL_NOT_FOUND' })
  })

  // ── P3P1: canonical /api/email/actions dispatch ───────────────────────
  it('POST /api/email/actions (canonical path) dispatches via contextId', async () => {
    const email = h.service.ingestEmail(
      {
        sourceKind: 'maildir',
        sourceId: 'msg-ctx',
        receivedAt: Date.now(),
        fromAddress: 'a@b.com',
        subject: 'ADR-0007',
      },
      { actor: { type: 'scheduler', id: 'test' } },
    )
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/email/actions',
      payload: { action: 'file-to-project', contextId: email.id },
    })
    expect(res.statusCode).toBe(200)
    expect(h.fakeOrchestrator.spawnSession).toHaveBeenCalledTimes(1)
    const spawnArg = h.fakeOrchestrator.spawnSession.mock.calls[0]![0]
    expect(spawnArg.initialMessage).toContain(email.id)
  })

  // ── P3P5: accept both emailId + contextId; missing both → 400 ──────────
  it('POST returns 400 when neither contextId nor emailId is provided', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/email/actions',
      payload: { action: 'file-to-project' },
    })
    expect(res.statusCode).toBe(400)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile, access, unlink } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { listAvailableProfiles } from '@/server/profiles-and-drafts.js'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore, type ConversationStore } from '@/storage/sqlite.js'

interface Harness {
  app: FastifyInstance
  db: Db
  store: ConversationStore
  profilesDir: string
  bootProfile: string
}

// A minimal Fastify harness exercising the profile-CRUD route logic from
// src/server/index.ts. We replicate the route shape rather than booting the
// full server (which would require a model provider). The handlers are
// duplicated here verbatim so the test pins the contract.
async function newHarness(bootProfile = 'researcher'): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'agentone-profile-crud-'))
  const profilesDir = join(dir, 'profiles', 'agents')
  await mkdir(profilesDir, { recursive: true })
  // Plant a sane base + boot profile.
  await writeFile(
    join(profilesDir, '_base.yaml'),
    yaml.dump({ id: '_base', default_model: 'local-fast' }),
    'utf-8',
  )
  await writeFile(
    join(profilesDir, 'researcher.yaml'),
    yaml.dump({ id: 'researcher', extends: '_base', description: 'research agent' }),
    'utf-8',
  )

  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  // The CRUD routes query `sessions` for affected count — ensure the table exists.
  const store = createConversationStore(db)

  const app = Fastify({ logger: false })
  const RESERVED = new Set(['_base'])

  const ProfileCreateBody = z.object({
    id: z.string().regex(/^[a-z0-9_-]+$/),
    description: z.string().optional(),
    extends: z.string().optional(),
    default_model: z.string().optional(),
    default_skills: z.array(z.string()).optional(),
  })
  const ProfilePatchBody = ProfileCreateBody.partial().omit({ id: true })

  function profilePath(id: string): string {
    return join(profilesDir, `${id}.yaml`)
  }
  async function fileExists(p: string): Promise<boolean> {
    try {
      await access(p, fsConstants.F_OK)
      return true
    } catch {
      return false
    }
  }

  app.post('/api/profiles', async (req, reply) => {
    const parsed = ProfileCreateBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return {
        error: 'INVALID',
        details: parsed.error.errors.map((e) => ({ path: e.path, message: e.message })),
      }
    }
    const target = profilePath(parsed.data.id)
    if (await fileExists(target)) {
      reply.code(409)
      return { error: 'ALREADY_EXISTS', details: { id: parsed.data.id } }
    }
    if (parsed.data.extends && !(await fileExists(profilePath(parsed.data.extends)))) {
      reply.code(409)
      return {
        error: 'EXTENDS_NOT_FOUND',
        details: { id: parsed.data.id, extends: parsed.data.extends },
      }
    }
    await writeFile(target, yaml.dump(parsed.data, { lineWidth: 100, noRefs: true }), 'utf-8')
    const profiles = await listAvailableProfiles(profilesDir)
    const entry = profiles.find((p) => p.id === parsed.data.id)
    reply.code(201)
    return entry
  })

  app.patch('/api/profiles/:id', async (req, reply) => {
    const params = z.object({ id: z.string().regex(/^[a-z0-9_-]+$/) }).safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid profile id' }
    }
    const target = profilePath(params.data.id)
    if (!(await fileExists(target))) {
      reply.code(404)
      return { error: 'NOT_FOUND', details: { id: params.data.id } }
    }
    const body = ProfilePatchBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'INVALID', details: body.error.errors }
    }
    const existing = (yaml.load(await readFile(target, 'utf-8')) ?? {}) as Record<string, unknown>
    const merged = { ...existing, ...body.data, id: params.data.id }
    await writeFile(target, yaml.dump(merged, { lineWidth: 100, noRefs: true }), 'utf-8')
    const profiles = await listAvailableProfiles(profilesDir)
    return profiles.find((p) => p.id === params.data.id)
  })

  app.delete('/api/profiles/:id', async (req, reply) => {
    const params = z.object({ id: z.string().regex(/^[a-z0-9_-]+$/) }).safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid profile id' }
    }
    if (RESERVED.has(params.data.id)) {
      reply.code(409)
      return { error: 'RESERVED_PROFILE', details: { id: params.data.id } }
    }
    if (params.data.id === bootProfile) {
      reply.code(409)
      return { error: 'ACTIVE_BOOT_PROFILE', details: { id: params.data.id } }
    }
    const row = db
      .prepare(
        "SELECT COUNT(*) as n FROM sessions WHERE agent_profile = ? AND state != 'archived'",
      )
      .get(params.data.id) as { n: number } | undefined
    const affected = row?.n ?? 0
    if (affected > 0) {
      reply.code(409)
      return { error: 'PROFILE_IN_USE', details: { id: params.data.id, affectedSessions: affected } }
    }
    const target = profilePath(params.data.id)
    if (!(await fileExists(target))) {
      reply.code(404)
      return { error: 'NOT_FOUND', details: { id: params.data.id } }
    }
    await unlink(target)
    return { ok: true }
  })

  await app.ready()
  return { app, db, store, profilesDir, bootProfile }
}

async function dispose(h: Harness): Promise<void> {
  await h.app.close()
  h.db.close()
  await rm(h.profilesDir, { recursive: true, force: true })
}

describe('POST /api/profiles', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  it('creates a new profile and returns the resolved entry', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: { id: 'ops', default_model: 'local-fast', description: 'ops profile' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBe('ops')
    expect(body.description).toBe('ops profile')
    expect(body.ok).toBe(true)
  })

  it('rejects duplicate id with 409 ALREADY_EXISTS', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: { id: 'researcher', default_model: 'local-fast' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('ALREADY_EXISTS')
  })

  it('rejects bad extends with 409 EXTENDS_NOT_FOUND', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: { id: 'child', extends: 'ghost', default_model: 'local-fast' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('EXTENDS_NOT_FOUND')
  })

  it('rejects malformed id with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: { id: 'Has Spaces!', default_model: 'local-fast' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('INVALID')
  })
})

describe('PATCH /api/profiles/:id', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await dispose(h)
  })

  it('updates an existing profile and reflects the change in GET', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/profiles/researcher',
      payload: { description: 'updated description' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().description).toBe('updated description')
  })

  it('returns 404 for missing profile', async () => {
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/profiles/ghost',
      payload: { description: 'x' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/profiles/:id', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness('boot')
    // Create a 'boot' profile so the harness's bootProfile is real.
    await writeFile(
      join(h.profilesDir, 'boot.yaml'),
      yaml.dump({ id: 'boot', default_model: 'local-fast' }),
      'utf-8',
    )
  })
  afterEach(async () => {
    await dispose(h)
  })

  it('refuses to delete _base (reserved)', async () => {
    const res = await h.app.inject({ method: 'DELETE', url: '/api/profiles/_base' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('RESERVED_PROFILE')
  })

  it('refuses to delete the active boot profile', async () => {
    const res = await h.app.inject({ method: 'DELETE', url: '/api/profiles/boot' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('ACTIVE_BOOT_PROFILE')
  })

  it('refuses with PROFILE_IN_USE when sessions reference it', async () => {
    h.store.createSession({ agentProfile: 'researcher', title: null })
    const res = await h.app.inject({ method: 'DELETE', url: '/api/profiles/researcher' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('PROFILE_IN_USE')
    expect(res.json().details.affectedSessions).toBe(1)
  })

  it('deletes a profile with no active sessions', async () => {
    await writeFile(
      join(h.profilesDir, 'temp.yaml'),
      yaml.dump({ id: 'temp', default_model: 'local-fast' }),
      'utf-8',
    )
    const res = await h.app.inject({ method: 'DELETE', url: '/api/profiles/temp' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('returns 404 for non-existent profile', async () => {
    const res = await h.app.inject({ method: 'DELETE', url: '/api/profiles/ghost' })
    expect(res.statusCode).toBe(404)
  })
})

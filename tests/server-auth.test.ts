import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultAllowedOrigins,
  ensureAuthToken,
  installAuthGate,
} from '../src/server/auth.js'

function buildAppWithAuth(token: string, allowedOrigins: string[] = ['http://localhost:3737']): FastifyInstance {
  const app = Fastify({ logger: false })
  installAuthGate(app, { enabled: true, token, allowedOrigins })
  app.get('/', async () => ({ shell: true }))
  app.get('/assets/app.js', async () => 'console.log(1)')
  app.get('/api/health', async () => ({ status: 'ok' }))
  app.get('/api/sessions', async () => ({ sessions: [] }))
  app.get('/ws', async () => ({ pseudo: 'ws' }))
  return app
}

describe('installAuthGate', () => {
  let app: FastifyInstance | null = null
  const token = 'test-token-' + 'x'.repeat(40)

  afterEach(async () => {
    if (app) {
      await app.close()
      app = null
    }
  })

  it('allows the SPA shell and static assets without a token', async () => {
    app = buildAppWithAuth(token)
    const shell = await app.inject({ method: 'GET', url: '/' })
    expect(shell.statusCode).toBe(200)
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(asset.statusCode).toBe(200)
  })

  it('rejects /api requests with no Authorization header (401 missing_token)', async () => {
    app = buildAppWithAuth(token)
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED', reason: 'missing_token' })
  })

  it('rejects /api requests with the wrong token (401 bad_token)', async () => {
    app = buildAppWithAuth(token)
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED', reason: 'bad_token' })
  })

  it('accepts /api with a valid Bearer token', async () => {
    app = buildAppWithAuth(token)
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('accepts /ws with ?token= (WS upgrades cannot set custom headers)', async () => {
    app = buildAppWithAuth(token)
    const res = await app.inject({
      method: 'GET',
      url: `/ws?token=${encodeURIComponent(token)}`,
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects /ws when ?token= is wrong', async () => {
    app = buildAppWithAuth(token)
    const res = await app.inject({ method: 'GET', url: '/ws?token=wrong' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects /ws with no token at all', async () => {
    app = buildAppWithAuth(token)
    const res = await app.inject({ method: 'GET', url: '/ws' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects requests with a disallowed Origin header (403 bad_origin)', async () => {
    app = buildAppWithAuth(token, ['http://localhost:3737'])
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'http://evil.example.com',
      },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'FORBIDDEN', reason: 'bad_origin' })
  })

  it('accepts requests with an allowed Origin header', async () => {
    app = buildAppWithAuth(token, ['http://localhost:3737'])
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'http://localhost:3737',
      },
    })
    expect(res.statusCode).toBe(200)
  })

  it('non-browser caller (no Origin header) is gated by bearer only', async () => {
    app = buildAppWithAuth(token, ['http://localhost:3737'])
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('is a no-op when enabled is false (tests bypass)', async () => {
    const a = Fastify({ logger: false })
    installAuthGate(a, { enabled: false, token: 'x', allowedOrigins: [] })
    a.get('/api/x', async () => ({ ok: true }))
    const res = await a.inject({ method: 'GET', url: '/api/x' })
    expect(res.statusCode).toBe(200)
    await a.close()
  })
})

describe('ensureAuthToken', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentone-auth-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('generates a token on first call and persists it', async () => {
    const first = await ensureAuthToken(dir)
    expect(first.created).toBe(true)
    expect(first.token.length).toBeGreaterThanOrEqual(40)
    const second = await ensureAuthToken(dir)
    expect(second.created).toBe(false)
    expect(second.token).toBe(first.token)
    expect(second.path).toBe(first.path)
  })

  it('regenerates if the file is empty or shorter than the threshold', async () => {
    const { writeFileSync } = await import('node:fs')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, '.auth'), { recursive: true })
    writeFileSync(join(dir, '.auth', 'token'), 'shortx', 'utf-8')
    const out = await ensureAuthToken(dir)
    expect(out.created).toBe(true)
    expect(out.token.length).toBeGreaterThanOrEqual(40)
  })
})

describe('defaultAllowedOrigins', () => {
  it('always includes the loopback aliases for the port', () => {
    expect(defaultAllowedOrigins('127.0.0.1', 3737)).toEqual([
      'http://127.0.0.1:3737',
      'http://localhost:3737',
    ])
  })

  it('adds the bound host when it is a LAN address', () => {
    const origins = defaultAllowedOrigins('192.168.1.10', 3737)
    expect(origins).toContain('http://192.168.1.10:3737')
    expect(origins).toContain('http://127.0.0.1:3737')
  })

  it('does not add 0.0.0.0 (a bind address, not a dial address)', () => {
    const origins = defaultAllowedOrigins('0.0.0.0', 3737)
    expect(origins).not.toContain('http://0.0.0.0:3737')
  })
})

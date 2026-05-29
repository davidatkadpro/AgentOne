import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyAllMigrationsForModule } from './helpers/module-migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import { createSecretVault, type SecretVault } from '@/storage/secret-vault.js'
import { createOAuthStateStore } from '@/modules/qbo/oauth-state.js'
import { createEmailService, type EmailService } from '../modules/email/src/service.js'
import { registerEmailRoutes } from '../modules/email/src/routes.js'
import type { GraphHttpClient, GraphTokenSet, GraphMe } from '@/modules/m365/source.js'

class FakeGraphClient implements GraphHttpClient {
  exchangeCalls: Array<{ code: string; redirectUri: string }> = []
  tokens: GraphTokenSet = { accessToken: 'acc-tok', refreshToken: 'ref-tok', expiresIn: 3600 }
  me_: GraphMe | null = {
    displayName: 'Knowles Studio',
    mail: 'studio@knowles.example',
    userPrincipalName: 'studio@knowles.example',
  }
  exchangeShouldThrow = false

  async exchangeCode(code: string, redirectUri: string): Promise<GraphTokenSet> {
    this.exchangeCalls.push({ code, redirectUri })
    if (this.exchangeShouldThrow) throw new Error('token exchange failed')
    return this.tokens
  }
  async refreshTokens(): Promise<GraphTokenSet> {
    return this.tokens
  }
  async me(): Promise<GraphMe | null> {
    return this.me_
  }
  async listMessages() {
    return []
  }
  async getMessage() {
    return null
  }
  async listAttachments() {
    return []
  }
  async getAttachmentContent() {
    return Buffer.alloc(0)
  }
  async markRead() {
    /* no-op */
  }
}

interface Harness {
  db: Db
  app: FastifyInstance
  service: EmailService
  vault: SecretVault
  client: FakeGraphClient
  oauthState: ReturnType<typeof createOAuthStateStore>
}

async function newHarness(opts: { withM365?: boolean } = {}): Promise<Harness> {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  applyAllMigrationsForModule(db, 'projects')
  applyAllMigrationsForModule(db, 'email')
  const audit = createAuditLog(db)
  const bus = new EventBus()
  const service = createEmailService({ db, eventBus: bus, audit })
  const vault = createSecretVault({ forceBackend: 'aes-gcm', env: { QBO_TOKEN_KEY: 'unit-test-key' } })
  const client = new FakeGraphClient()
  const oauthState = createOAuthStateStore()
  const app = Fastify({ logger: false })
  const deps: Parameters<typeof registerEmailRoutes>[1] = { service }
  if (opts.withM365 !== false) {
    deps.m365 = {
      client,
      vault,
      oauthState,
      clientId: 'client-abc',
      scopes: 'offline_access Mail.Read User.Read',
      redirectUri: 'http://127.0.0.1:3737/api/integrations/m365/callback',
      authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    }
  }
  await registerEmailRoutes(app, deps)
  await app.ready()
  return { db, app, service, vault, client, oauthState }
}

describe('M365 OAuth routes', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await h.app.close()
    h.db.close()
  })

  it('GET /api/integrations/m365/connect mints state and redirects to the authorize URL', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/integrations/m365/connect' })
    expect(res.statusCode).toBe(302)
    const loc = res.headers.location as string
    const url = new URL(loc)
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    )
    expect(url.searchParams.get('client_id')).toBe('client-abc')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('response_mode')).toBe('query')
    expect(url.searchParams.get('scope')).toBe('offline_access Mail.Read User.Read')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:3737/api/integrations/m365/callback',
    )
    expect(url.searchParams.get('state')).toBeTruthy()
  })

  it('connect returns 503 when M365 is not configured', async () => {
    const bare = await newHarness({ withM365: false })
    const res = await bare.app.inject({ method: 'GET', url: '/api/integrations/m365/connect' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ error: 'M365_NOT_CONFIGURED' })
    await bare.app.close()
    bare.db.close()
  })

  it('callback with a valid state exchanges the code and stores an encrypted connection', async () => {
    const state = h.oauthState.mint()
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/integrations/m365/callback?code=auth-code-1&state=${state}`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/settings?tab=integrations&m365=connected')
    expect(h.client.exchangeCalls).toHaveLength(1)
    expect(h.client.exchangeCalls[0]!.code).toBe('auth-code-1')

    const conn = h.service.getM365Connection()
    expect(conn).not.toBeNull()
    expect(conn!.accountEmail).toBe('studio@knowles.example')
    expect(conn!.accountName).toBe('Knowles Studio')
    // Tokens are stored encrypted and round-trip through the vault.
    expect(h.vault.decrypt(conn!.accessTokenEncrypted)).toBe('acc-tok')
    expect(h.vault.decrypt(conn!.refreshTokenEncrypted)).toBe('ref-tok')
  })

  it('callback rejects an unknown/expired state without exchanging', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/integrations/m365/callback?code=x&state=not-a-real-state',
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/settings?tab=integrations&m365=error&reason=bad_state')
    expect(h.client.exchangeCalls).toHaveLength(0)
    expect(h.service.getM365Connection()).toBeNull()
  })

  it('callback with no code redirects with missing_code', async () => {
    const state = h.oauthState.mint()
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/integrations/m365/callback?state=${state}`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/settings?tab=integrations&m365=error&reason=missing_code')
  })

  it('callback surfaces an upstream exchange failure as an error redirect', async () => {
    h.client.exchangeShouldThrow = true
    const state = h.oauthState.mint()
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/integrations/m365/callback?code=c&state=${state}`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('m365=error&reason=')
    expect(h.service.getM365Connection()).toBeNull()
  })

  it('GET status returns connected:false then the connection details', async () => {
    const before = await h.app.inject({ method: 'GET', url: '/api/email/m365/status' })
    expect(before.json()).toEqual({ connected: false })

    const state = h.oauthState.mint()
    await h.app.inject({
      method: 'GET',
      url: `/api/integrations/m365/callback?code=c&state=${state}`,
    })

    const after = await h.app.inject({ method: 'GET', url: '/api/email/m365/status' })
    const body = after.json()
    expect(body.connected).toBe(true)
    expect(body.accountEmail).toBe('studio@knowles.example')
    expect(typeof body.tokenExpiresAt).toBe('number')
    // The status payload must never leak token material.
    expect(JSON.stringify(body)).not.toContain('acc-tok')
    expect(JSON.stringify(body)).not.toContain('ref-tok')
  })

  it('POST disconnect clears the connection; 404 when not connected', async () => {
    const notConnected = await h.app.inject({
      method: 'POST',
      url: '/api/integrations/m365/disconnect',
    })
    expect(notConnected.statusCode).toBe(404)
    expect(notConnected.json()).toMatchObject({ error: 'NOT_CONNECTED' })

    const state = h.oauthState.mint()
    await h.app.inject({
      method: 'GET',
      url: `/api/integrations/m365/callback?code=c&state=${state}`,
    })
    expect(h.service.getM365Connection()).not.toBeNull()

    const res = await h.app.inject({ method: 'POST', url: '/api/integrations/m365/disconnect' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(h.service.getM365Connection()).toBeNull()
  })
})

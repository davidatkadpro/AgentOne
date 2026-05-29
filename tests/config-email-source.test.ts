import { describe, it, expect, afterEach } from 'vitest'
import { loadConfigFromEnv } from '@/server/config.js'

// loadConfigFromEnv reads process.env directly. Snapshot + restore the keys we
// touch so these cases don't leak into other suites.
const KEYS = [
  'EMAIL_SOURCE',
  'EMAIL_MAILDIR_PATH',
  'EMAIL_POLL_INTERVAL_MIN',
  'M365_CLIENT_ID',
  'M365_CLIENT_SECRET',
  'M365_TENANT_ID',
  'M365_AUTHORIZE_URL',
  'M365_TOKEN_URL',
] as const

const saved: Record<string, string | undefined> = {}
for (const k of KEYS) saved[k] = process.env[k]

function reset(): void {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}

describe('config — email source resolution', () => {
  afterEach(reset)

  it('infers maildir when only EMAIL_MAILDIR_PATH is set', () => {
    for (const k of KEYS) delete process.env[k]
    process.env.EMAIL_MAILDIR_PATH = './tmp/maildir'
    expect(loadConfigFromEnv().emailSourceKind).toBe('maildir')
  })

  it('infers graph when M365 creds are present', () => {
    for (const k of KEYS) delete process.env[k]
    process.env.M365_CLIENT_ID = 'client-123'
    process.env.M365_CLIENT_SECRET = 'secret-abc'
    expect(loadConfigFromEnv().emailSourceKind).toBe('graph')
  })

  it('infers none when nothing is configured', () => {
    for (const k of KEYS) delete process.env[k]
    expect(loadConfigFromEnv().emailSourceKind).toBe('none')
  })

  it('explicit EMAIL_SOURCE=maildir wins even when M365 creds exist', () => {
    for (const k of KEYS) delete process.env[k]
    process.env.M365_CLIENT_ID = 'client-123'
    process.env.M365_CLIENT_SECRET = 'secret-abc'
    process.env.EMAIL_SOURCE = 'maildir'
    expect(loadConfigFromEnv().emailSourceKind).toBe('maildir')
  })

  it('derives Entra v2 authorize/token URLs from the tenant', () => {
    for (const k of KEYS) delete process.env[k]
    process.env.M365_TENANT_ID = 'contoso.onmicrosoft.com'
    const cfg = loadConfigFromEnv()
    expect(cfg.m365AuthorizeUrl).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
    )
    expect(cfg.m365TokenUrl).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    )
  })

  it('defaults the tenant to common and the poll interval to 5', () => {
    for (const k of KEYS) delete process.env[k]
    const cfg = loadConfigFromEnv()
    expect(cfg.m365TenantId).toBe('common')
    expect(cfg.m365AuthorizeUrl).toContain('/common/oauth2/v2.0/authorize')
    expect(cfg.emailPollIntervalMinutes).toBe(5)
  })

  it('honours explicit authorize/token URL overrides', () => {
    for (const k of KEYS) delete process.env[k]
    process.env.M365_AUTHORIZE_URL = 'https://login.microsoftonline.us/x/authorize'
    process.env.M365_TOKEN_URL = 'https://login.microsoftonline.us/x/token'
    const cfg = loadConfigFromEnv()
    expect(cfg.m365AuthorizeUrl).toBe('https://login.microsoftonline.us/x/authorize')
    expect(cfg.m365TokenUrl).toBe('https://login.microsoftonline.us/x/token')
  })
})

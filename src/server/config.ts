import { z } from 'zod'
import { resolve } from 'node:path'

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3737),
  HOST: z.string().default('127.0.0.1'),
  DB_PATH: z.string().default('./data/agentone.db'),
  BASE_PROMPT_PATH: z.string().default('./prompts/base.md'),
  MODEL_PROFILES_DIR: z.string().default('./profiles/models'),
  AGENT_PROFILES_DIR: z.string().default('./profiles/agents'),
  AGENT_PROFILE: z.string().default('_base'),
  SKILLS_DIR: z.string().default('./skills'),
  LMSTUDIO_BASE_URL: z.string().url().default('http://localhost:1234/v1'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_API_KEY: z.string().optional(),
  // Optional metadata OpenRouter recommends sending. They surface app name in
  // their dashboard and respect HTTP-Referer for rate-limit identity.
  OPENROUTER_APP_TITLE: z.string().default('AgentOne'),
  OPENROUTER_HTTP_REFERER: z.string().optional(),
  DEFAULT_MODEL_PROFILE: z.string().default('local-fast'),
  COMPRESSOR_MODEL_PROFILE: z.string().default('local-compressor'),
  EMBEDDING_MODEL_PROFILE: z.string().default('local-embed'),
  FRONTEND_DIR: z.string().default('./src/web/dist'),
  STORAGE_ROOT: z.string().default('./storage'),
  WIKI_PREFIX: z.string().default('wiki'),
  /** When set, install the example audit-log hook and write a JSONL record
   *  per tool call to this path. Empty / unset disables the hook. */
  AUDIT_LOG_PATH: z.string().optional(),
  /** Optional path to a YAML file declaring event-bus hooks. Each entry
   *  maps an event type (or "*") to a handler module. Missing file is
   *  silently ignored. See src/hooks/event-hook-runner.ts. */
  EVENT_HOOKS_PATH: z.string().optional(),
  /** Optional absolute path to a folder of `.eml` files for the
   *  MaildirEmailSource (dev / offline fallback). Unset means no email
   *  source is wired and `POST /api/v1/email/poll` returns 503. */
  EMAIL_MAILDIR_PATH: z.string().optional(),
  /** Which email connector to wire. Explicit switch (restart required). When
   *  unset we infer: `graph` if M365 creds are present, else `maildir` if
   *  EMAIL_MAILDIR_PATH is set, else none. */
  EMAIL_SOURCE: z.enum(['graph', 'maildir']).optional(),
  /** Graph has no cheap local watch (webhooks need a public URL), so we poll.
   *  Interval in minutes for the GraphEmailPoller. */
  EMAIL_POLL_INTERVAL_MIN: z.coerce.number().int().positive().default(5),
  /** Microsoft 365 (Graph) OAuth app credentials. When client id+secret are
   *  unset, the M365 connect/status routes report not-configured and the
   *  graph source can't be wired. Single-tenant, single-user. */
  M365_CLIENT_ID: z.string().optional(),
  M365_CLIENT_SECRET: z.string().optional(),
  /** Entra tenant: a tenant GUID, a verified domain, or `common`/`organizations`
   *  /`consumers`. Used to build the authorize/token URLs. */
  M365_TENANT_ID: z.string().default('common'),
  M365_REDIRECT_URI: z
    .string()
    .default('http://127.0.0.1:3737/api/integrations/m365/callback'),
  /** Space-delimited delegated scopes. `offline_access` is required for a
   *  refresh token; `Mail.Read` for the inbox; `User.Read` for /me. */
  M365_SCOPES: z.string().default('offline_access Mail.Read User.Read'),
  /** Optional overrides for the authorize/token endpoints (sovereign clouds).
   *  When unset they are derived from M365_TENANT_ID against login.microsoftonline.com. */
  M365_AUTHORIZE_URL: z.string().optional(),
  M365_TOKEN_URL: z.string().optional(),
  /** QuickBooks Online OAuth client id (Phase 5). When unset, the QBO sync
   *  routes return 503 QBO_NOT_CONFIGURED. */
  QBO_CLIENT_ID: z.string().optional(),
  QBO_CLIENT_SECRET: z.string().optional(),
  QBO_REDIRECT_URI: z
    .string()
    .default('http://127.0.0.1:3737/api/integrations/qbo/callback'),
  QBO_AUTHORIZE_URL: z.string().default('https://appcenter.intuit.com/connect/oauth2'),
  /** Override for the AES-GCM secret-vault key on non-Windows hosts. On
   *  Windows the vault uses DPAPI by default — this is only consulted as a
   *  fallback. Required for the QBO routes to start outside Windows. */
  QBO_TOKEN_KEY: z.string().optional(),
  /** Pull poll interval in minutes (default 15). */
  QBO_PULL_INTERVAL_MIN: z.coerce.number().int().positive().default(15),
  LOG_EVENTS: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /** Comma-separated list of additional `Origin` header values allowed on
   *  browser requests. The loopback aliases for the bound port are always
   *  allowed. Use this when serving the SPA from a non-default origin. */
  ALLOWED_ORIGINS: z.string().optional(),
  /** Opt-in flag required when HOST is non-loopback. Set to "1" to
   *  acknowledge that the API will be reachable beyond the local machine. */
  ALLOW_UNAUTH_NETWORK: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
})

export interface ServerConfig {
  port: number
  host: string
  dbPath: string
  basePromptPath: string
  modelProfilesDir: string
  agentProfilesDir: string
  agentProfile: string
  skillsDir: string
  lmStudioBaseUrl: string
  openRouterBaseUrl: string
  openRouterApiKey: string | null
  openRouterAppTitle: string
  openRouterHttpReferer: string | null
  defaultModelProfile: string
  compressorModelProfile: string
  embeddingModelProfile: string
  frontendDir: string
  storageRoot: string
  wikiPrefix: string
  auditLogPath: string | null
  eventHooksPath: string | null
  emailMaildirPath: string | null
  /** Resolved active email connector: explicit EMAIL_SOURCE, else inferred. */
  emailSourceKind: 'graph' | 'maildir' | 'none'
  emailPollIntervalMinutes: number
  m365ClientId: string | null
  m365ClientSecret: string | null
  m365TenantId: string
  m365RedirectUri: string
  m365Scopes: string
  m365AuthorizeUrl: string
  m365TokenUrl: string
  qboClientId: string | null
  qboClientSecret: string | null
  qboRedirectUri: string
  qboAuthorizeUrl: string
  qboPullIntervalMinutes: number
  logEvents: boolean
  /** Extra browser origins permitted on `/api` and `/ws` (loopback aliases
   *  for the bound port are always allowed). */
  allowedOrigins: string[]
  /** Operator opt-in: true allows binding to a non-loopback host. */
  allowUnauthNetwork: boolean
}

export function loadConfigFromEnv(): ServerConfig {
  const parsed = Env.parse(process.env)
  const m365Configured = Boolean(parsed.M365_CLIENT_ID && parsed.M365_CLIENT_SECRET)
  const maildirConfigured = Boolean(parsed.EMAIL_MAILDIR_PATH)
  // Explicit switch wins; otherwise infer from what's configured.
  const emailSourceKind: ServerConfig['emailSourceKind'] =
    parsed.EMAIL_SOURCE ??
    (m365Configured ? 'graph' : maildirConfigured ? 'maildir' : 'none')
  // Entra v2 endpoints, derived from the tenant unless explicitly overridden.
  const authorizeUrl =
    parsed.M365_AUTHORIZE_URL ??
    `https://login.microsoftonline.com/${parsed.M365_TENANT_ID}/oauth2/v2.0/authorize`
  const tokenUrl =
    parsed.M365_TOKEN_URL ??
    `https://login.microsoftonline.com/${parsed.M365_TENANT_ID}/oauth2/v2.0/token`
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    dbPath: parsed.DB_PATH,
    basePromptPath: parsed.BASE_PROMPT_PATH,
    modelProfilesDir: parsed.MODEL_PROFILES_DIR,
    agentProfilesDir: resolve(parsed.AGENT_PROFILES_DIR),
    agentProfile: parsed.AGENT_PROFILE,
    skillsDir: resolve(parsed.SKILLS_DIR),
    lmStudioBaseUrl: parsed.LMSTUDIO_BASE_URL,
    openRouterBaseUrl: parsed.OPENROUTER_BASE_URL,
    openRouterApiKey: parsed.OPENROUTER_API_KEY ?? null,
    openRouterAppTitle: parsed.OPENROUTER_APP_TITLE,
    openRouterHttpReferer: parsed.OPENROUTER_HTTP_REFERER ?? null,
    defaultModelProfile: parsed.DEFAULT_MODEL_PROFILE,
    compressorModelProfile: parsed.COMPRESSOR_MODEL_PROFILE,
    embeddingModelProfile: parsed.EMBEDDING_MODEL_PROFILE,
    frontendDir: parsed.FRONTEND_DIR,
    storageRoot: resolve(parsed.STORAGE_ROOT),
    wikiPrefix: parsed.WIKI_PREFIX,
    auditLogPath: parsed.AUDIT_LOG_PATH ? resolve(parsed.AUDIT_LOG_PATH) : null,
    eventHooksPath: parsed.EVENT_HOOKS_PATH ? resolve(parsed.EVENT_HOOKS_PATH) : null,
    emailMaildirPath: parsed.EMAIL_MAILDIR_PATH ? resolve(parsed.EMAIL_MAILDIR_PATH) : null,
    emailSourceKind,
    emailPollIntervalMinutes: parsed.EMAIL_POLL_INTERVAL_MIN,
    m365ClientId: parsed.M365_CLIENT_ID ?? null,
    m365ClientSecret: parsed.M365_CLIENT_SECRET ?? null,
    m365TenantId: parsed.M365_TENANT_ID,
    m365RedirectUri: parsed.M365_REDIRECT_URI,
    m365Scopes: parsed.M365_SCOPES,
    m365AuthorizeUrl: authorizeUrl,
    m365TokenUrl: tokenUrl,
    qboClientId: parsed.QBO_CLIENT_ID ?? null,
    qboClientSecret: parsed.QBO_CLIENT_SECRET ?? null,
    qboRedirectUri: parsed.QBO_REDIRECT_URI,
    qboAuthorizeUrl: parsed.QBO_AUTHORIZE_URL,
    qboPullIntervalMinutes: parsed.QBO_PULL_INTERVAL_MIN,
    logEvents: parsed.LOG_EVENTS,
    allowedOrigins: parsed.ALLOWED_ORIGINS
      ? parsed.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
    allowUnauthNetwork: parsed.ALLOW_UNAUTH_NETWORK,
  }
}

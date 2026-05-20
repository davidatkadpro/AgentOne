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
  FRONTEND_DIR: z.string().default('./src/frontend'),
  STORAGE_ROOT: z.string().default('./storage'),
  WIKI_PREFIX: z.string().default('wiki'),
  LOG_EVENTS: z
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
  logEvents: boolean
}

export function loadConfigFromEnv(): ServerConfig {
  const parsed = Env.parse(process.env)
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
    logEvents: parsed.LOG_EVENTS,
  }
}

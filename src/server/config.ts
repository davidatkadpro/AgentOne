import { z } from 'zod'

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3737),
  DB_PATH: z.string().default('./data/agentone.db'),
  BASE_PROMPT_PATH: z.string().default('./prompts/base.md'),
  MODEL_PROFILES_DIR: z.string().default('./profiles/models'),
  LMSTUDIO_BASE_URL: z.string().url().default('http://localhost:1234/v1'),
  DEFAULT_MODEL_PROFILE: z.string().default('local-fast'),
  COMPRESSOR_MODEL_PROFILE: z.string().default('local-compressor'),
  FRONTEND_DIR: z.string().default('./src/frontend'),
  LOG_EVENTS: z.string().default('0'),
})

export interface ServerConfig {
  port: number
  dbPath: string
  basePromptPath: string
  modelProfilesDir: string
  lmStudioBaseUrl: string
  defaultModelProfile: string
  compressorModelProfile: string
  frontendDir: string
  logEvents: boolean
}

export function loadConfigFromEnv(): ServerConfig {
  const parsed = Env.parse(process.env)
  return {
    port: parsed.PORT,
    dbPath: parsed.DB_PATH,
    basePromptPath: parsed.BASE_PROMPT_PATH,
    modelProfilesDir: parsed.MODEL_PROFILES_DIR,
    lmStudioBaseUrl: parsed.LMSTUDIO_BASE_URL,
    defaultModelProfile: parsed.DEFAULT_MODEL_PROFILE,
    compressorModelProfile: parsed.COMPRESSOR_MODEL_PROFILE,
    frontendDir: parsed.FRONTEND_DIR,
    logEvents: parsed.LOG_EVENTS === '1' || parsed.LOG_EVENTS.toLowerCase() === 'true',
  }
}

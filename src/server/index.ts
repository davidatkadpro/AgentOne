import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { readFile, readdir, stat, writeFile, unlink, access } from 'node:fs/promises'
import yaml from 'js-yaml'
import { constants as fsConstants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function detectPandoc(): Promise<boolean> {
  // Cross-platform: `pandoc --version` exits 0 if on PATH, non-zero otherwise.
  try {
    await execFileAsync('pandoc', ['--version'], { timeout: 2000 })
    return true
  } catch {
    return false
  }
}

import { loadConfigFromEnv, type ServerConfig } from './config.js'
import { EventBus } from '../core/events.js'
import { loadBasePrompt } from '../profiles/base-prompt.js'
import { loadModelProfiles } from '../profiles/model-profile.js'
import { loadAgentProfile } from '../profiles/agent-profile.js'
import { ContextManager } from '../context/context-manager.js'
import { AutoDistillScheduler } from '../orchestrator/auto-distill.js'
import { AutoTitler } from '../orchestrator/auto-titler.js'
import { loadEventHooks } from '../hooks/event-hook-runner.js'
import { listAvailableProfiles, listDrafts } from './profiles-and-drafts.js'
import { DocumentIndex } from '../memory/documents/doc-index.js'
import { extractByFormat } from '../../skills/system/documents/tools/extractors.js'
import { LMStudioProvider } from '../providers/lmstudio.js'
import { OpenRouterProvider } from '../providers/openrouter.js'
import { ProviderRegistry } from '../providers/registry.js'
import type { Provider } from '../providers/base.js'
import { HookRegistry } from '../skills/hooks.js'
import { buildAuditLogHook } from '../skills/audit-log-hook.js'
import { createDatabase, type Db } from '../storage/db.js'
import { createConversationStore, type ConversationStore } from '../storage/sqlite.js'
import { createNotifications } from '../modules/notifications.js'
import { createAuditLog } from '../modules/audit-log.js'
import { bootModules, type ModuleRegistry } from '../modules/registry.js'
import { createProjectsService, type ProjectsService } from '../../modules/projects/src/service.js'
import { registerProjectsRoutes } from '../../modules/projects/src/routes.js'
import { createEmailService } from '../../modules/email/src/service.js'
import { registerEmailRoutes } from '../../modules/email/src/routes.js'
import { registerEmailActions } from '../../modules/email/src/actions.js'
import { registerModuleActionsDiscovery } from '../modules/action-discovery.js'
import { MaildirEmailSource } from '../../modules/email/src/sources/maildir.js'
import { createProposalsService, type ProposalsService } from '../../modules/proposals/src/service.js'
import { registerProposalsRoutes } from '../../modules/proposals/src/routes.js'
import { registerProposalsActions } from '../../modules/proposals/src/actions.js'
import { createInvoicingService, type InvoicingService } from '../../modules/invoicing/src/service.js'
import { registerInvoicingRoutes } from '../../modules/invoicing/src/routes.js'
import { registerInvoicingActions } from '../../modules/invoicing/src/actions.js'
import { createSecretVault, type SecretVault } from '../storage/secret-vault.js'
import { HttpQboClient } from '../modules/qbo/auth.js'
import { createOAuthStateStore } from '../modules/qbo/oauth-state.js'
import { QboPoller } from '../modules/qbo/poller.js'
import { LocalFolderAdapter } from '../storage/local-folder.js'
import { WikiEngine } from '../memory/wiki/engine.js'
import { Orchestrator } from '../orchestrator/turn.js'
import { loadSkillIndex, type SkillIndex } from '../skills/loader.js'
import type { ModelProfile } from '../core/types.js'
import { buildCommandRegistry } from './commands/builders.js'
import type { CommandRegistry } from './commands/registry.js'
import type { CommandResult } from './commands/types.js'
import { buildHybridRecall } from '../search/hybrid.js'
import { EmbeddingIndexer } from '../search/embedding-indexer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SendMessageBody = z.object({ text: z.string().min(1) })
const RenameSessionBody = z.object({ title: z.string().min(1).max(200) })
const CreateSessionBody = z.object({
  /** Optional. When omitted, the server uses its boot agentProfile. When
   *  present and != boot profile, /api/sessions returns 409 (Path A
   *  single-profile-per-server). */
  agentProfile: z.string().optional(),
  title: z.string().nullable().optional(),
  /** Optional spawn seed. When present, the orchestrator creates the session
   *  AND runs the first turn with `seed.initialMessage` immediately, emitting
   *  `session.spawned` for the audit log. Without `seed`, the route behaves
   *  as before — just creates a row, awaiting a user message. */
  seed: z
    .object({
      spawnedBy: z.string().min(1),
      initialMessage: z.string().min(1),
    })
    .optional(),
})
const SessionIdParams = z.object({ id: z.string().uuid() })
const WsClientMessage = z.union([
  z.object({ op: z.literal('subscribe'), sessionId: z.string() }),
  z.object({ op: z.literal('unsubscribe'), sessionId: z.string() }),
])

// Transient events are NOT written to event_log. Bus subscribers can still
// see them; we just don't burn DB rows on high-cardinality flows.
const TRANSIENT_EVENT_TYPES = new Set([
  'message.assistant.delta',
  'embedding.indexed',
])

export interface AppDeps {
  config: ServerConfig
  bus: EventBus
  store: ConversationStore
  orchestrator: Orchestrator
  conversationModel: ModelProfile
  wiki: WikiEngine
  skillIndex: SkillIndex
  contextManager: ContextManager
  commands: CommandRegistry
  /** Compressor model + provider (per-profile). Same model the
   *  ContextManager uses for summarisation; reused by /distill. */
  compressorProvider: Provider
  compressorModel: string
  /** Raw SQLite handle. Used by /backup to drive the online-backup API. */
  db: Db
  /** Registry of v2 Modules booted from `modules/`. Routes that operate on
   *  Module-owned state look up their service via this. */
  modules: ModuleRegistry
  /** Notification store — surfaces in /api/notifications routes for the
   *  React notification tray (see ADR-0006). */
  notifications: ReturnType<typeof createNotifications>
  /** Shared audit log handle. Surfaced so Module routes can read by
   *  project_id without re-opening the DB. */
  audit: ReturnType<typeof createAuditLog>
  /** QBO sync wiring — present only when the operator has set
   *  QBO_CLIENT_ID/SECRET (and a viable vault key path). When absent, the
   *  Invoicing routes register the local-only subset and return 503 for
   *  push/pull/reconcile/connect/callback. */
  qbo?: {
    client: InstanceType<typeof HttpQboClient>
    vault: SecretVault
    oauthState: ReturnType<typeof createOAuthStateStore>
    clientId: string
    clientSecret: string
    redirectUri: string
    authorizeUrl: string
  }
}

const CommandRequestBody = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  /** Optional follow-up text — only used by skill slash_commands. */
  text: z.string().optional(),
})

const GlobalCommandBody = CommandRequestBody.extend({
  sessionId: z.string().uuid().optional(),
})

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(fastifyWebsocket)
  await app.register(fastifyStatic, {
    root: resolve(__dirname, '..', '..', deps.config.frontendDir),
    prefix: '/',
  })

  // Detect pandoc once at boot (P1S4). `which`/`where` cross-platform via PATH
  //  resolution from execFile; cache result.
  const pandocAvailable = await detectPandoc()

  app.get('/api/health', async () => {
    await deps.wiki.whenReady()
    // Q2: surface the email source's state so the top-bar can show a banner
    // when the configured maildir is unreachable. We re-stat on each request
    // — cheap on local disk and avoids stale "ok" reports.
    let emailSource: { kind: string; ok: boolean; configured: boolean } | undefined
    if (deps.config.emailMaildirPath) {
      try {
        const { stat: fsstat } = await import('node:fs/promises')
        await fsstat(deps.config.emailMaildirPath)
        emailSource = { kind: 'maildir', ok: true, configured: true }
      } catch {
        emailSource = { kind: 'maildir', ok: false, configured: true }
      }
    } else {
      emailSource = { kind: 'none', ok: true, configured: false }
    }
    return {
      status: 'ok',
      model: deps.conversationModel.id,
      contextWindow: deps.conversationModel.contextWindow,
      storageRoot: deps.config.storageRoot,
      wikiPrefix: deps.config.wikiPrefix,
      agentProfile: deps.config.agentProfile,
      capabilities: {
        pandoc: pandocAvailable,
      },
      emailSource,
    }
  })

  app.get('/api/sessions', async () => ({
    sessions: deps.store.listSessions(),
  }))

  app.get('/api/profiles', async () => {
    const profiles = await listAvailableProfiles(deps.config.agentProfilesDir)
    return { profiles, current: deps.config.agentProfile }
  })

  // --- Profile CRUD (P1S1-S3) ---
  // The raw YAML schema lives in profiles/agent-profile.ts; we re-define a
  // permissive body schema here that aligns with the file shape but tolerates
  // partial bodies (PATCH) and the create-vs-edit asymmetry.
  const ProfileCreateBody = z.object({
    id: z.string().regex(/^[a-z0-9_-]+$/),
    description: z.string().optional(),
    extends: z.string().optional(),
    system_prompt_file: z.string().optional(),
    default_model: z.string().optional(),
    compressor_model: z.string().optional(),
    default_skills: z.array(z.string()).optional(),
    permissions: z.unknown().optional(),
    passive_recall: z.unknown().optional(),
    auto_distill: z.unknown().optional(),
    deny_tools: z.array(z.string()).optional(),
  })
  const ProfilePatchBody = ProfileCreateBody.partial().omit({ id: true })
  const RESERVED_PROFILE_IDS = new Set(['_base'])

  function profilePath(id: string): string {
    return resolve(deps.config.agentProfilesDir, `${id}.yaml`)
  }

  async function fileExists(p: string): Promise<boolean> {
    try {
      await access(p, fsConstants.F_OK)
      return true
    } catch {
      return false
    }
  }

  function countActiveSessionsForProfile(id: string): number {
    // The store has no helper for this — query the DB directly.
    const row = deps.db
      .prepare(
        "SELECT COUNT(*) as n FROM sessions WHERE agent_profile = ? AND state != 'archived'",
      )
      .get(id) as { n: number } | undefined
    return row?.n ?? 0
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
    const id = parsed.data.id
    const target = profilePath(id)
    if (await fileExists(target)) {
      reply.code(409)
      return { error: 'ALREADY_EXISTS', details: { id } }
    }
    if (parsed.data.extends) {
      const basePath = profilePath(parsed.data.extends)
      if (!(await fileExists(basePath))) {
        reply.code(409)
        return { error: 'EXTENDS_NOT_FOUND', details: { id, extends: parsed.data.extends } }
      }
    }
    const yamlText = yaml.dump(parsed.data, { lineWidth: 100, noRefs: true })
    await writeFile(target, yamlText, 'utf-8')
    // Re-resolve through the real loader so the response shape matches
    // GET /api/profiles entries (with `ok` flag + resolved defaults).
    const profiles = await listAvailableProfiles(deps.config.agentProfilesDir)
    const entry = profiles.find((p) => p.id === id)
    if (!entry) {
      reply.code(500)
      return { error: 'INTERNAL', message: 'Profile created but not found in re-scan' }
    }
    reply.code(201)
    return entry
  })

  app.patch('/api/profiles/:id', async (req, reply) => {
    const params = z.object({ id: z.string().regex(/^[a-z0-9_-]+$/) }).safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid profile id' }
    }
    const id = params.data.id
    const target = profilePath(id)
    if (!(await fileExists(target))) {
      reply.code(404)
      return { error: 'NOT_FOUND', details: { id } }
    }
    const body = ProfilePatchBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return {
        error: 'INVALID',
        details: body.error.errors.map((e) => ({ path: e.path, message: e.message })),
      }
    }
    const existingText = await readFile(target, 'utf-8')
    const existing = (yaml.load(existingText) ?? {}) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...existing, ...body.data, id }
    // Validate the merged result against the full schema by writing it and
    // re-loading via listAvailableProfiles — that's the same code path the
    // GET endpoint and the orchestrator use, so a passing PATCH means the
    // file is loadable. Write a temp copy first so we can roll back on error.
    const mergedYaml = yaml.dump(merged, { lineWidth: 100, noRefs: true })
    await writeFile(target, mergedYaml, 'utf-8')
    const profiles = await listAvailableProfiles(deps.config.agentProfilesDir)
    const entry = profiles.find((p) => p.id === id)
    if (!entry) {
      // Should never happen — we just wrote it. Surface a 500 with context.
      reply.code(500)
      return { error: 'INTERNAL', message: 'Profile re-scan dropped the row' }
    }
    if (!entry.ok) {
      // Roll back: restore the pre-edit YAML so a bad PATCH doesn't break the
      // boot profile or leave the file in a broken state.
      await writeFile(target, existingText, 'utf-8')
      reply.code(400)
      return { error: 'INVALID', details: [{ path: [], message: entry.error ?? 'unknown' }] }
    }
    return entry
  })

  app.delete('/api/profiles/:id', async (req, reply) => {
    const params = z.object({ id: z.string().regex(/^[a-z0-9_-]+$/) }).safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid profile id' }
    }
    const id = params.data.id
    if (RESERVED_PROFILE_IDS.has(id)) {
      reply.code(409)
      return { error: 'RESERVED_PROFILE', details: { id } }
    }
    if (id === deps.config.agentProfile) {
      reply.code(409)
      return { error: 'ACTIVE_BOOT_PROFILE', details: { id } }
    }
    const affected = countActiveSessionsForProfile(id)
    if (affected > 0) {
      reply.code(409)
      return { error: 'PROFILE_IN_USE', details: { id, affectedSessions: affected } }
    }
    const target = profilePath(id)
    if (!(await fileExists(target))) {
      reply.code(404)
      return { error: 'NOT_FOUND', details: { id } }
    }
    await unlink(target)
    return { ok: true }
  })

  app.get('/api/drafts', async () => {
    const drafts = await listDrafts(deps.config.storageRoot)
    return { drafts }
  })

  // P1S6 — Read-only listing of event-hook entries. Settings → Hooks tab
  // renders these so the operator can audit what runs without restarting.
  // Reads the YAML from disk on each request — the file is small and
  // operators may hand-edit it; caching at boot would lie about live state.
  app.get('/api/hooks', async () => {
    if (!deps.config.eventHooksPath) {
      return { hooks: [], configPath: null }
    }
    try {
      const raw = await readFile(deps.config.eventHooksPath, 'utf-8')
      const parsed = yaml.load(raw)
      if (!Array.isArray(parsed)) {
        return { hooks: [], configPath: deps.config.eventHooksPath, error: 'NOT_A_LIST' }
      }
      const hooks = (parsed as Array<Record<string, unknown>>)
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({
          event: typeof e.on === 'string' ? e.on : '*',
          handler: typeof e.handler === 'string' ? e.handler : '',
          description: typeof e.description === 'string' ? e.description : null,
          enabled: e.enabled !== false, // default true; only `enabled: false` opts out
        }))
        .filter((h) => h.handler.length > 0)
      return { hooks, configPath: deps.config.eventHooksPath }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { hooks: [], configPath: deps.config.eventHooksPath }
      }
      return {
        hooks: [],
        configPath: deps.config.eventHooksPath,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  app.post('/api/sessions', async (req, reply) => {
    const parsed = CreateSessionBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: 'Invalid body', details: parsed.error.flatten() }
    }
    // Path A: single-profile-per-server. An explicit mismatch is rejected;
    // an omitted profile inherits the boot profile so callers don't have to
    // know it. The orchestrator enforces the same invariant at session-open
    // time as a defence-in-depth for sessions created by older clients.
    const requested = parsed.data.agentProfile
    if (requested !== undefined && requested !== deps.config.agentProfile) {
      reply.code(409)
      return {
        error: 'PROFILE_MISMATCH',
        message:
          `Server is running agent profile "${deps.config.agentProfile}" — ` +
          `cannot create a session under "${requested}". ` +
          `Restart with AGENT_PROFILE=${requested}, or omit agentProfile to use the boot profile.`,
      }
    }
    if (parsed.data.seed) {
      // Spawned-session path: orchestrator owns row creation + first turn so
      // session.spawned fires in the right order relative to message.user.received.
      const spawnInput: Parameters<typeof deps.orchestrator.spawnSession>[0] = {
        spawnedBy: parsed.data.seed.spawnedBy,
        initialMessage: parsed.data.seed.initialMessage,
      }
      if (parsed.data.title != null) spawnInput.title = parsed.data.title
      if (requested !== undefined) spawnInput.agentProfile = requested
      const result = await deps.orchestrator.spawnSession(spawnInput)
      void drain(result.handle.stream)
      return { session: result.session }
    }
    const session = deps.store.createSession({
      agentProfile: requested ?? deps.config.agentProfile,
      title: parsed.data.title ?? null,
    })
    await deps.bus.emit({
      type: 'session.created',
      sessionId: session.id,
      agentProfile: session.agentProfile,
      ts: Date.now(),
    })
    return { session }
  })

  app.get('/api/sessions/:id', async (req, reply) => {
    const params = SessionIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid session id' }
    }
    const session = deps.store.getSession(params.data.id)
    if (!session) {
      reply.code(404)
      return { error: 'Not found' }
    }
    const turns = deps.store.listTurns(params.data.id)
    const toolCalls: Record<string, ReturnType<typeof deps.store.listToolCalls>> = {}
    for (const turn of turns) {
      if (turn.role !== 'assistant') continue
      const calls = deps.store.listToolCalls(turn.id)
      if (calls.length > 0) toolCalls[turn.id] = calls
    }
    return { session, turns, toolCalls }
  })

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const params = SessionIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid session id' }
    }
    const session = deps.store.getSession(params.data.id)
    if (!session) {
      reply.code(404)
      return { error: 'Session not found' }
    }
    const mismatch = profileMismatchResponse(session, deps.config.agentProfile)
    if (mismatch) {
      reply.code(409)
      return mismatch
    }
    const body = SendMessageBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'Invalid body', details: body.error.flatten() }
    }
    const handle = await deps.orchestrator.handleUserMessage(params.data.id, body.data.text)
    void drain(handle.stream)
    return { ok: true }
  })

  app.post('/api/sessions/:id/cancel', async (req, reply) => {
    const params = SessionIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid session id' }
    }
    const outcome = await deps.orchestrator.cancelSession(params.data.id)
    return { outcome }
  })

  app.patch('/api/sessions/:id', async (req, reply) => {
    const params = SessionIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid session id' }
    }
    const body = RenameSessionBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'Invalid body', details: body.error.flatten() }
    }
    const session = deps.store.getSession(params.data.id)
    if (!session) {
      reply.code(404)
      return { error: 'Session not found' }
    }
    deps.store.setSessionTitle(params.data.id, body.data.title)
    await deps.bus.emit({
      type: 'session.titled',
      sessionId: params.data.id,
      title: body.data.title,
      ts: Date.now(),
    })
    return { session: { ...session, title: body.data.title } }
  })

  // --- Notifications HTTP routes (P1S5) ---
  app.get('/api/notifications', async (req) => {
    const query = z
      .object({
        includeResolved: z.union([z.literal('true'), z.literal('false')]).optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      })
      .safeParse(req.query ?? {})
    const includeResolved = query.success && query.data.includeResolved === 'true'
    const limit = query.success ? query.data.limit ?? 100 : 100
    const all = deps.notifications.list({ limit })
    const filtered = includeResolved
      ? all
      : all.filter((n) => n.status === 'unread' || n.status === 'read')
    return { notifications: filtered }
  })

  const NotificationIdParams = z.object({ id: z.coerce.number().int().positive() })
  const UpdateNotificationBody = z.object({
    status: z.enum(['read', 'resolved', 'dismissed']),
  })

  app.patch('/api/notifications/:id', async (req, reply) => {
    const params = NotificationIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid notification id' }
    }
    const body = UpdateNotificationBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'Invalid body', details: body.error.flatten() }
    }
    const existing = deps.notifications.get(params.data.id)
    if (!existing) {
      reply.code(404)
      return { error: 'Not found' }
    }
    if (body.data.status === 'read') deps.notifications.markRead(params.data.id)
    else if (body.data.status === 'resolved') deps.notifications.resolve(params.data.id)
    else deps.notifications.dismiss(params.data.id)
    const updated = deps.notifications.get(params.data.id)
    return { notification: updated }
  })

  const AnswerNotificationBody = z.object({ value: z.string().min(1) })

  app.post(
    '/api/sessions/:id/notifications/:notifId/answer',
    async (req, reply) => {
      const params = z
        .object({
          id: z.string().uuid(),
          notifId: z.coerce.number().int().positive(),
        })
        .safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'Invalid params' }
      }
      const body = AnswerNotificationBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'Invalid body', details: body.error.flatten() }
      }
      const session = deps.store.getSession(params.data.id)
      if (!session) {
        reply.code(404)
        return { error: 'Session not found' }
      }
      const notif = deps.notifications.get(params.data.notifId)
      if (!notif) {
        reply.code(404)
        return { error: 'Notification not found' }
      }
      const mismatch = profileMismatchResponse(session, deps.config.agentProfile)
      if (mismatch) {
        reply.code(409)
        return mismatch
      }
      // 1. Post the value as a user message on the session.
      const handle = await deps.orchestrator.handleUserMessage(
        params.data.id,
        body.data.value,
      )
      void drain(handle.stream)
      // 2. Resolve the notification.
      deps.notifications.resolve(params.data.notifId)
      return { ok: true }
    },
  )

  app.get('/api/skills', async () => {
    const skills = [...deps.skillIndex.skills.values()].map((s) => ({
      qualifiedName: s.qualifiedName,
      name: s.name,
      category: s.category,
      description: s.description,
      slashCommand: s.slashCommand,
      allowedTools: (s.frontmatter as { 'allowed-tools'?: string[] })['allowed-tools'] ?? [],
      body: s.body,
    }))
    return { skills: skills.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)) }
  })

  app.get('/api/commands', async () => {
    const built = deps.commands.list().map((c) => ({
      name: c.name,
      description: c.description,
      usage: c.usage,
      requiresSession: c.requiresSession,
      source: 'system' as const,
    }))
    const skillSlashes = [...deps.skillIndex.bySlashCommand.values()].map((m) => ({
      name: m.slashCommand as string,
      description: m.description,
      usage: `/${m.slashCommand} [text]`,
      requiresSession: true,
      source: 'skill' as const,
      skill: m.qualifiedName,
    }))
    return { commands: [...built, ...skillSlashes].sort((a, b) => a.name.localeCompare(b.name)) }
  })

  app.post('/api/sessions/:id/command', async (req, reply) => {
    const params = SessionIdParams.safeParse(req.params)
    if (!params.success) {
      reply.code(400)
      return { error: 'Invalid session id' }
    }
    const session = deps.store.getSession(params.data.id)
    if (session) {
      const mismatch = profileMismatchResponse(session, deps.config.agentProfile)
      if (mismatch) {
        reply.code(409)
        return mismatch
      }
    }
    const body = CommandRequestBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'Invalid body', details: body.error.flatten() }
    }
    const result = await dispatchCommand(deps, body.data, params.data.id)
    return { result }
  })

  app.post('/api/command', async (req, reply) => {
    const body = GlobalCommandBody.safeParse(req.body ?? {})
    if (!body.success) {
      reply.code(400)
      return { error: 'Invalid body', details: body.error.flatten() }
    }
    const result = await dispatchCommand(deps, body.data, body.data.sessionId ?? null)
    return { result }
  })

  app.register(async function (instance) {
    instance.get('/ws', { websocket: true }, (socket, req) => {
      const subscriptions = new Set<string>()

      // Subscribe at handshake time via ?sessionId=xxx (repeatable) so a
      // reconnecting client doesn't race against in-flight events. The
      // legacy {op:'subscribe'} message path below still works.
      const query = req.query as Record<string, unknown> | undefined
      if (query) {
        const raw = query.sessionId
        const ids = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
        for (const id of ids) if (typeof id === 'string' && id) subscriptions.add(id)
      }

      const off = deps.bus.onAny((e) => {
        if (subscriptions.size === 0) return
        if (!('sessionId' in e)) return
        if (e.sessionId === null || !subscriptions.has(e.sessionId)) return
        try {
          socket.send(JSON.stringify(e))
        } catch {
          /* socket closed mid-send */
        }
      })

      socket.on('message', (raw: Buffer | string) => {
        try {
          const parsed = WsClientMessage.safeParse(JSON.parse(String(raw)))
          if (!parsed.success) return
          if (parsed.data.op === 'subscribe') subscriptions.add(parsed.data.sessionId)
          else subscriptions.delete(parsed.data.sessionId)
        } catch {
          /* invalid json; ignore */
        }
      })

      const cleanup = (): void => {
        off()
        subscriptions.clear()
      }
      socket.on('close', cleanup)
      socket.on('error', cleanup)
    })
  })

  // Module-owned routes. Each Module that wants HTTP exposure registers under
  // /api/v1/<module>/...; routes look up their service via the registry.
  const projectsHandle = deps.modules.get('projects')
  if (projectsHandle?.status === 'active' && projectsHandle.service) {
    const projectsService = projectsHandle.service as Parameters<
      typeof registerProjectsRoutes
    >[1]['service']
    await registerProjectsRoutes(app, {
      service: projectsService,
      audit: deps.audit,
      storageRoot: deps.config.storageRoot,
    })
  }

  const proposalsHandle = deps.modules.get('proposals')
  if (proposalsHandle?.status === 'active' && proposalsHandle.service) {
    const proposalsService = proposalsHandle.service as Parameters<
      typeof registerProposalsRoutes
    >[1]['service']
    await registerProposalsRoutes(app, {
      service: proposalsService,
      audit: deps.audit,
      storageRoot: deps.config.storageRoot,
      modulesRoot: resolve(__dirname, '..', '..', 'modules'),
      pandocAvailable,
      eventBus: deps.bus,
    })
    // POST /api/proposals/actions — dispatch a Skill against a project
    // context. Mirrors modules/email/src/actions.ts.
    const projectsHandleForProposals = deps.modules.get('projects')
    if (projectsHandleForProposals?.status === 'active' && projectsHandleForProposals.service) {
      await registerProposalsActions(app, {
        orchestrator: deps.orchestrator,
        projects: projectsHandleForProposals.service as ProjectsService,
        skillsDir: join(proposalsHandle.rootPath, 'skills'),
        eventBus: deps.bus,
      })
    }
  }

  const invoicingHandle = deps.modules.get('invoicing')
  if (invoicingHandle?.status === 'active' && invoicingHandle.service) {
    const invoicingService = invoicingHandle.service as Parameters<
      typeof registerInvoicingRoutes
    >[1]['service']
    const invoicingDeps: Parameters<typeof registerInvoicingRoutes>[1] = {
      service: invoicingService,
      audit: deps.audit,
      eventBus: deps.bus,
      pandocAvailable,
    }
    if (deps.qbo) {
      invoicingDeps.qbo = {
        client: deps.qbo.client,
        vault: deps.qbo.vault,
        oauthState: deps.qbo.oauthState,
        clientId: deps.qbo.clientId,
        clientSecret: deps.qbo.clientSecret,
        redirectUri: deps.qbo.redirectUri,
        authorizeUrl: deps.qbo.authorizeUrl,
      }
    }
    await registerInvoicingRoutes(app, invoicingDeps)
    await registerInvoicingActions(app, {
      orchestrator: deps.orchestrator,
      invoicing: invoicingService as InvoicingService,
      skillsDir: join(invoicingHandle.rootPath, 'skills'),
      eventBus: deps.bus,
    })
  }

  const emailHandle = deps.modules.get('email')
  if (emailHandle?.status === 'active' && emailHandle.service) {
    const emailService = emailHandle.service as Parameters<
      typeof registerEmailRoutes
    >[1]['service']
    const emailDeps: Parameters<typeof registerEmailRoutes>[1] = {
      service: emailService,
    }
    if (deps.config.emailMaildirPath) {
      const source = new MaildirEmailSource({ root: deps.config.emailMaildirPath })
      emailDeps.source = source
      // P3P7: fs-watcher on the maildir root. New `.eml` files auto-ingest
      // without waiting for the manual POST /api/email/poll.
      const stopWatch = source.watch?.((sourceId) => {
        void emailService
          .ingestOne(source, sourceId, { actor: { type: 'scheduler', id: 'email-watch' } })
          .catch(() => {
            // best-effort; broken individual messages don't break the watcher
          })
      })
      if (stopWatch) {
        app.addHook('onClose', async () => {
          stopWatch()
        })
      }
    }
    await registerEmailRoutes(app, emailDeps)
    await registerEmailActions(app, {
      service: emailService,
      orchestrator: deps.orchestrator,
      skillsDir: join(emailHandle.rootPath, 'skills'),
      eventBus: deps.bus,
    })
  }

  // Action discovery (ADR-0007 / P2S1). One uniform GET /api/<module>/actions
  // per booted module that has a skills/ subdir — the frontend's
  // <ActionToolbar> / <AskAgentMenu> consume this without per-module wiring.
  for (const moduleName of ['email', 'projects', 'proposals', 'invoicing'] as const) {
    const handle = deps.modules.get(moduleName)
    if (handle?.status !== 'active') continue
    registerModuleActionsDiscovery(app, {
      module: moduleName,
      skillsDir: join(handle.rootPath, 'skills'),
      eventBus: deps.bus,
    })
  }

  return app
}

/**
 * Lightweight scan of `modules/` to collect skill roots. Doesn't validate
 * MODULE.md beyond existence — the bootModules pass later does the full
 * manifest check. Returns the list of `{ module, root }` entries to hand
 * to loadSkillIndex; modules without a `skills/` subdir are skipped.
 */
async function discoverModuleSkillRoots(
  modulesRoot: string,
): Promise<Array<{ module: string; root: string }>> {
  const out: Array<{ module: string; root: string }> = []
  let entries
  try {
    entries = await readdir(modulesRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const moduleDir = join(modulesRoot, ent.name)
    const manifestPath = join(moduleDir, 'MODULE.md')
    const skillsDir = join(moduleDir, 'skills')
    try {
      await stat(manifestPath)
    } catch {
      continue
    }
    try {
      const s = await stat(skillsDir)
      if (s.isDirectory()) {
        out.push({ module: ent.name, root: skillsDir })
      }
    } catch {
      // No skills dir — module exists but contributes no Skills.
    }
  }
  return out
}

async function drain(stream: AsyncIterable<string>): Promise<void> {
  // The orchestrator's stream emits deltas as observer events; iterating
  // here only drives its generator past completion so the finally-block
  // persists the assistant turn.
  for await (const _ of stream) void _
}

function profileMismatchResponse(
  session: { agentProfile: string },
  bootProfile: string,
): { error: 'PROFILE_MISMATCH'; message: string } | null {
  if (session.agentProfile === bootProfile) return null
  return {
    error: 'PROFILE_MISMATCH',
    message:
      `Session was created under agent profile "${session.agentProfile}", ` +
      `but this server is running "${bootProfile}". ` +
      `Restart with AGENT_PROFILE=${session.agentProfile} to open it.`,
  }
}

/**
 * Resolve a command name to either a system command or a skill slash_command.
 * Skill commands LOAD the skill and forward any trailing text as a user
 * message (matching the PRD's "skill commands" semantics).
 */
async function dispatchCommand(
  deps: AppDeps,
  body: { name: string; args?: Record<string, unknown>; text?: string },
  sessionId: string | null,
): Promise<CommandResult> {
  const args = body.args ?? {}
  if (deps.commands.has(body.name)) {
    return deps.commands.dispatch(body.name, args, {
      sessionId,
      store: deps.store,
      skillIndex: deps.skillIndex,
      orchestrator: deps.orchestrator,
      contextManager: deps.contextManager,
      config: deps.config,
      wiki: deps.wiki,
      compressorProvider: deps.compressorProvider,
      compressorModel: deps.compressorModel,
      db: deps.db,
    })
  }
  const manifest = deps.skillIndex.bySlashCommand.get(body.name)
  if (!manifest) {
    return { kind: 'error', message: `Unknown command: /${body.name}`, recoverable: true }
  }
  if (!sessionId) {
    return {
      kind: 'error',
      message: `/${body.name} requires an active session`,
      recoverable: true,
    }
  }
  const loaded = await deps.orchestrator.loadSkillIntoSession(sessionId, manifest.qualifiedName)
  if (!loaded.alreadyLoaded && !loaded.loaded) {
    return {
      kind: 'error',
      message: `Could not load ${manifest.qualifiedName}: ${loaded.reason}`,
      recoverable: loaded.reason.startsWith('permission denied'),
    }
  }
  const forwarded = !!body.text && body.text.trim().length > 0
  if (forwarded) {
    const handle = await deps.orchestrator.handleUserMessage(sessionId, body.text as string)
    void drain(handle.stream)
  }
  return {
    kind: 'skill_invoked',
    skill: manifest.qualifiedName,
    forwarded,
    alreadyLoaded: loaded.alreadyLoaded,
  }
}

export async function bootstrap(): Promise<void> {
  const config = loadConfigFromEnv()
  const bus = new EventBus()

  if (config.logEvents) {
    bus.onAny((e) => {
      // eslint-disable-next-line no-console
      console.log(`[event] ${e.type}`)
    })
  }

  const db = createDatabase({ path: config.dbPath })
  const store = createConversationStore(db)
  const notifications = createNotifications(db, { bus })
  const audit = createAuditLog(db)
  const storage = new LocalFolderAdapter({ root: config.storageRoot })
  const wiki = new WikiEngine({ storage, db, prefix: config.wikiPrefix })
  const documents = new DocumentIndex({
    storage,
    db,
    extract: async (path, content) => {
      try {
        const extracted = await extractByFormat(path, content)
        return extracted ? extracted.text : null
      } catch {
        // Extraction failure on one file shouldn't break the index pass.
        return null
      }
    },
  })

  bus.onAny((e) => {
    if (TRANSIENT_EVENT_TYPES.has(e.type)) return
    if (!('sessionId' in e)) return
    store.logEvent({
      sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
      type: e.type,
      payload: e,
    })
  })

  // Discover Module-scoped Skills alongside the top-level `skills/` tree.
  // We just need the *paths* here — actual Module service instantiation
  // happens later via bootModules. Scanning modules/<name>/skills/ keeps
  // skill discovery cheap and parallel to the existing categories scan.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const modulesRoot = join(repoRoot, 'modules')
  const moduleSkillRoots = await discoverModuleSkillRoots(modulesRoot)

  const [basePrompt, modelProfiles, agentProfile, skillIndex] = await Promise.all([
    loadBasePrompt(config.basePromptPath),
    loadModelProfiles(config.modelProfilesDir),
    loadAgentProfile(config.agentProfilesDir, config.agentProfile),
    loadSkillIndex({ root: config.skillsDir, moduleSkillRoots }),
  ])

  const conversationModelId =
    agentProfile.defaultModel === 'local-fast' || agentProfile.defaultModel === ''
      ? config.defaultModelProfile
      : agentProfile.defaultModel
  const compressorModelId =
    agentProfile.compressorModel ?? config.compressorModelProfile

  const conversationModel = modelProfiles.get(conversationModelId)
  if (!conversationModel) {
    throw new Error(
      `Conversation Model Profile not found: ${conversationModelId} (referenced by agent profile ${agentProfile.id})`,
    )
  }
  const compressorModel = modelProfiles.get(compressorModelId)
  if (!compressorModel) {
    throw new Error(`Compressor Model Profile not found: ${compressorModelId}`)
  }

  // Build a provider registry — LMStudio is always registered; OpenRouter is
  // registered only when an API key is configured. The orchestrator + recall
  // + indexer continue to use the local provider directly because the
  // conversation/compressor/embedding models are local-fast / local-compressor /
  // local-embed. consult_expert looks up providers via the registry.
  const providers = new ProviderRegistry()
  const lmstudio = new LMStudioProvider({ baseUrl: config.lmStudioBaseUrl })
  providers.register(lmstudio)
  if (config.openRouterApiKey) {
    providers.register(
      new OpenRouterProvider({
        baseUrl: config.openRouterBaseUrl,
        apiKey: config.openRouterApiKey,
        appTitle: config.openRouterAppTitle,
        ...(config.openRouterHttpReferer && { httpReferer: config.openRouterHttpReferer }),
      }),
    )
  }
  const conversationProvider = providers.get(conversationModel.provider)
  const compressorProvider = providers.get(compressorModel.provider)

  // Embedding profile is optional — if it's not configured we still run, but
  // search_history degrades to FTS5-only and no background indexing fires.
  const embeddingModel = modelProfiles.get(config.embeddingModelProfile)
  const embeddingProvider = embeddingModel ? providers.get(embeddingModel.provider) : null
  const recall = buildHybridRecall({
    store,
    provider: embeddingProvider ?? conversationProvider,
    embeddingModel: embeddingModel?.model ?? '',
    eventBus: bus,
  })
  const indexer = embeddingModel && embeddingProvider
    ? new EmbeddingIndexer({
        store,
        provider: embeddingProvider,
        model: embeddingModel.model,
        eventBus: bus,
      })
    : null
  if (indexer) {
    // Nudge the indexer whenever a user or assistant turn is recorded.
    bus.on('message.user.received', () => indexer.nudge())
    bus.on('message.assistant.completed', () => indexer.nudge())
    indexer.start()
  }

  const contextManager = new ContextManager({
    compressorProvider,
    compressorModel: compressorModel.model,
    contextWindow: conversationModel.contextWindow,
    eventBus: bus,
  })

  // The agent profile may also reference its own system_prompt_file, layered
  // on top of the base prompt. Compose at orchestrator level so per-session
  // state can also see it; here we just thread basePrompt through and let
  // the orchestrator apply the agent profile system prompt as part of
  // composeSystemMessage when we extend it (deferred for M3).
  let effectiveBasePrompt = basePrompt
  if (agentProfile.systemPromptFile) {
    try {
      const extra = (await readFile(agentProfile.systemPromptFile, 'utf-8')).trim()
      if (extra) effectiveBasePrompt = `${basePrompt}\n\n${extra}`
    } catch {
      // Profile names a system_prompt_file that doesn't exist; tolerate.
    }
  }

  // Cross-cutting tool hooks (redaction, audit, deny rules). The example
  // audit-log hook is opt-in via AUDIT_LOG_PATH — when set, every tool call
  // appends a JSONL record to that file so operators have a tamper-evident
  // record outside the SQLite event_log.
  const hookRegistry = new HookRegistry()
  if (config.auditLogPath) {
    hookRegistry.addPostHook(buildAuditLogHook({ path: config.auditLogPath }))
    // eslint-disable-next-line no-console
    console.log(`  Tool audit log: ${config.auditLogPath}`)
  }

  // Boot v2 Modules from `modules/` at the repo root. Each Module's
  // `MODULE.md` declares deps + version; `schema/*.sql` files are run via the
  // shared migration runner; the matching factory below produces the service
  // instance the ModuleRegistry exposes. Modules without an entry in the
  // factories map are discovered but ship no service (manifest + tables only).
  const modules = await bootModules({
    db,
    rootDir: modulesRoot,
    eventBus: bus,
    audit,
    storage,
    factories: {
      projects: (ctx) =>
        createProjectsService({
          db: ctx.db,
          eventBus: ctx.eventBus,
          audit: ctx.audit,
          storage: ctx.storage,
        }),
      email: (ctx) => {
        const projectsHandle = ctx.modules.get('projects')
        const projects =
          projectsHandle?.status === 'active' && projectsHandle.service
            ? (projectsHandle.service as ProjectsService)
            : undefined
        const deps: Parameters<typeof createEmailService>[0] = {
          db: ctx.db,
          eventBus: ctx.eventBus,
          audit: ctx.audit,
          storage: ctx.storage,
        }
        if (projects) deps.projects = projects
        return createEmailService(deps)
      },
      proposals: (ctx) => {
        const projectsHandle = ctx.modules.get('projects')
        const projects =
          projectsHandle?.status === 'active' && projectsHandle.service
            ? (projectsHandle.service as ProjectsService)
            : undefined
        const deps: Parameters<typeof createProposalsService>[0] = {
          db: ctx.db,
          eventBus: ctx.eventBus,
          audit: ctx.audit,
          storage: ctx.storage,
        }
        if (projects) deps.projects = projects
        return createProposalsService(deps)
      },
      invoicing: (ctx) => {
        const projectsHandle = ctx.modules.get('projects')
        const projects =
          projectsHandle?.status === 'active' && projectsHandle.service
            ? (projectsHandle.service as ProjectsService)
            : undefined
        const proposalsHandle = ctx.modules.get('proposals')
        const proposals =
          proposalsHandle?.status === 'active' && proposalsHandle.service
            ? (proposalsHandle.service as ProposalsService)
            : undefined
        const deps: Parameters<typeof createInvoicingService>[0] = {
          db: ctx.db,
          eventBus: ctx.eventBus,
          audit: ctx.audit,
        }
        if (projects) deps.projects = projects
        if (proposals) deps.proposals = proposals
        return createInvoicingService(deps)
      },
    },
  })
  for (const handle of modules.list()) {
    if (handle.status === 'degraded') {
      // eslint-disable-next-line no-console
      console.warn(`[modules] ${handle.name} degraded: ${handle.degradedReason}`)
    }
  }

  const orchestrator = new Orchestrator({
    store,
    contextManager,
    provider: conversationProvider,
    conversationModel,
    hooks: hookRegistry,
    eventBus: bus,
    skillIndex,
    profile: agentProfile,
    basePrompt: effectiveBasePrompt,
    passiveRecall: agentProfile.passiveRecall,
    services: {
      storage,
      wiki,
      documents,
      conversationStore: store,
      recall,
      providers,
      modelProfiles,
      eventBus: bus,
      notifications,
      modules,
    },
  })

  // Auto-titler: always on. Generates short titles for sessions that hit
  // the trigger threshold without one. Failures are swallowed inside the
  // titler — never blocks the chat.
  const autoTitler = new AutoTitler(
    {},
    {
      store,
      titlerProvider: compressorProvider,
      titlerModel: compressorModel.model,
      eventBus: bus,
    },
  )
  autoTitler.start()

  // Event hooks: optional YAML-declared subscribers run on every matching
  // bus event. Used for tee-to-file logging, custom alerting, etc. Failures
  // inside a handler are isolated — never propagate back into the bus.
  if (config.eventHooksPath) {
    try {
      const runner = await loadEventHooks(config.eventHooksPath)
      if (runner) {
        runner.start(bus)
        // eslint-disable-next-line no-console
        console.log(`  Event hooks: ${runner.hookCount()} loaded from ${config.eventHooksPath}`)
      } else {
        // eslint-disable-next-line no-console
        console.log(`  Event hooks: file not found at ${config.eventHooksPath} (skipped)`)
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`  Event hooks: failed to load — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const commands = buildCommandRegistry(skillIndex)

  // Start the auto-distill scheduler if the active profile opts in.
  // The scheduler subscribes to event-bus activity, primes its state from
  // the existing session list, and runs periodic scans in the background.
  let autoDistillScheduler: AutoDistillScheduler | null = null
  if (agentProfile.autoDistill.enabled) {
    autoDistillScheduler = new AutoDistillScheduler(
      { ...agentProfile.autoDistill, storageRoot: config.storageRoot },
      {
        store,
        wiki,
        compressorProvider,
        compressorModel: compressorModel.model,
        eventBus: bus,
      },
    )
    autoDistillScheduler.start()
    // eslint-disable-next-line no-console
    console.log(
      `  Auto-distill: enabled (idle ${agentProfile.autoDistill.idleMinutes}min, scan every ${agentProfile.autoDistill.scanIntervalMinutes}min)`,
    )
  }

  // ── QBO sync wiring (Phase 5) ────────────────────────────────────────
  // Only wired when QBO_CLIENT_ID + QBO_CLIENT_SECRET are present. The
  // secret-vault throws at construct time if neither DPAPI nor QBO_TOKEN_KEY
  // is available on a non-Windows host — we surface that as a degraded boot
  // line so the operator can see why the integration is off.
  let qboBundle: AppDeps['qbo']
  if (config.qboClientId && config.qboClientSecret) {
    try {
      const vault = createSecretVault()
      const client = new HttpQboClient({
        clientId: config.qboClientId,
        clientSecret: config.qboClientSecret,
      })
      const oauthState = createOAuthStateStore()
      qboBundle = {
        client,
        vault,
        oauthState,
        clientId: config.qboClientId,
        clientSecret: config.qboClientSecret,
        redirectUri: config.qboRedirectUri,
        authorizeUrl: config.qboAuthorizeUrl,
      }
      // eslint-disable-next-line no-console
      console.log(`  QBO sync: enabled (vault=${vault.backend})`)

      const invoicingHandle = modules.get('invoicing')
      if (invoicingHandle?.status === 'active' && invoicingHandle.service) {
        const invoicingService = invoicingHandle.service as ReturnType<
          typeof createInvoicingService
        >
        const poller = new QboPoller({
          service: invoicingService,
          client,
          vault,
          intervalMs: config.qboPullIntervalMinutes * 60_000,
        })
        poller.start()
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `  QBO sync: disabled — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('  QBO sync: disabled (QBO_CLIENT_ID / QBO_CLIENT_SECRET not set)')
  }

  const app = await buildApp({
    config,
    bus,
    store,
    orchestrator,
    conversationModel,
    wiki,
    skillIndex,
    contextManager,
    commands,
    compressorProvider,
    compressorModel: compressorModel.model,
    db,
    modules,
    notifications,
    audit,
    ...(qboBundle && { qbo: qboBundle }),
  })

  await wiki.whenReady()
  await app.listen({ port: config.port, host: config.host })
  // Show a friendly URL — 0.0.0.0 is a bind address, not a dial address.
  const displayHost = config.host === '0.0.0.0' ? '<lan-ip>' : config.host
  // eslint-disable-next-line no-console
  console.log(`AgentOne listening on http://${displayHost}:${config.port}`)
  if (config.host === '0.0.0.0') {
    // eslint-disable-next-line no-console
    console.log('  WARNING: bound to 0.0.0.0 — reachable by anyone on this network. No auth is enforced.')
  }
  // eslint-disable-next-line no-console
  console.log(
    `  profile=${agentProfile.id}  model=${conversationModel.id}  skills=${skillIndex.skills.size}`,
  )
}

const entryUrl = pathToFileURL(process.argv[1] ?? '').href
if (import.meta.url === entryUrl) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Bootstrap failed:', err)
    process.exit(1)
  })
}

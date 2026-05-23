import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { SkillFrontmatterSchema } from '../skills/frontmatter.js'
import { parseFrontmatter } from '../memory/wiki/frontmatter.js'
import type { EventBus } from '../core/events.js'

/**
 * Module-action discovery + endpoint mounting (ADR-0007 / v2-business-flow.md
 * "Action discovery & dispatch"). One implementation, mounted once per module.
 * Reads `modules/<name>/skills/*\/SKILL.md` and projects the frontmatter into
 * the descriptor shape the React frontend's `<ActionToolbar>` and
 * `<AskAgentMenu>` consume.
 *
 * Dispatch (`POST /api/<module>/actions`) stays module-specific because each
 * module's context-lookup differs (email → email row, projects → project row,
 * etc.) — see `modules/email/src/actions.ts` for the reference dispatcher.
 */

export interface ActionDescriptor {
  name: string
  label: string
  description: string
  icon: string | null
  defaultProfile: string | null
  requiresConfirmation: boolean
  surface: 'action' | 'ask_agent' | 'both'
  tabs: string[]
}

export interface ActionDiscovery {
  actions: ActionDescriptor[]
  errors: Array<{ skill: string; error: string }>
}

export interface DiscoverActionsOptions {
  /** Absolute path to `modules/<name>/skills/`. */
  skillsDir: string
}

/**
 * Walk `<skillsDir>/<skill-folder>/SKILL.md` and parse each. Broken Skills
 * land in `errors[]` rather than crashing the panel — same `ok: false`
 * pattern as `GET /api/profiles`.
 *
 * Pure I/O + parse: no caching here. The route handler in
 * `registerModuleActionsDiscovery` adds an mtime-keyed cache.
 */
export async function discoverActions(opts: DiscoverActionsOptions): Promise<ActionDiscovery> {
  let entries
  try {
    entries = await readdir(opts.skillsDir, { withFileTypes: true })
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return { actions: [], errors: [] }
    }
    throw err
  }
  const actions: ActionDescriptor[] = []
  const errors: Array<{ skill: string; error: string }> = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const skillMd = join(opts.skillsDir, ent.name, 'SKILL.md')
    let raw: string
    try {
      raw = await readFile(skillMd, 'utf-8')
    } catch {
      errors.push({ skill: ent.name, error: 'SKILL.md missing' })
      continue
    }
    const parsed = parseFrontmatter(raw)
    const validated = SkillFrontmatterSchema.safeParse(parsed.frontmatter)
    if (!validated.success) {
      errors.push({ skill: ent.name, error: validated.error.message })
      continue
    }
    const fm = validated.data
    actions.push({
      name: fm.name,
      label: fm.label ?? titleCase(fm.name),
      description: fm.description,
      icon: fm.icon ?? null,
      defaultProfile: fm.default_profile ?? null,
      requiresConfirmation: fm.requires_confirmation ?? false,
      surface: fm.surface ?? 'ask_agent',
      tabs: fm.tabs ?? [],
    })
  }
  actions.sort((a, b) => a.name.localeCompare(b.name))
  return { actions, errors }
}

function titleCase(kebab: string): string {
  return kebab
    .split('-')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ')
}

export interface RegisterDiscoveryDeps {
  /** Module name as it appears in the route — e.g. `email`, `projects`. */
  module: string
  /** Absolute path to `modules/<name>/skills/`. */
  skillsDir: string
  /** Optional. When present, a `module.reloaded` event fires whenever the
   *  cache miss path runs (i.e. skills/ mtime changed). The React UI uses
   *  it to refresh `useModuleActions(module)` without a page reload (P2P12). */
  eventBus?: EventBus
}

interface CachedDiscovery {
  mtimeMs: number
  result: ActionDiscovery
}

/**
 * Mount `GET /api/<module>/actions`. Result is cached per-module until the
 * `skillsDir` mtime changes (dropping a new skill folder bumps the dir's
 * mtime, invalidating the cache without a server restart).
 */
export function registerModuleActionsDiscovery(
  app: FastifyInstance,
  deps: RegisterDiscoveryDeps,
): void {
  let cache: CachedDiscovery | null = null
  app.get(`/api/${deps.module}/actions`, async () => {
    let mtimeMs: number
    try {
      const s = await stat(deps.skillsDir)
      mtimeMs = s.mtimeMs
    } catch {
      // Skills dir missing — module simply has no actions.
      return { actions: [], errors: [] }
    }
    if (cache && cache.mtimeMs === mtimeMs) {
      return cache.result
    }
    const isReload = cache !== null
    const result = await discoverActions({ skillsDir: deps.skillsDir })
    cache = { mtimeMs, result }
    if (isReload && deps.eventBus) {
      void deps.eventBus.emit({
        type: 'module.reloaded',
        module: deps.module,
        ts: Date.now(),
      })
    }
    return result
  })
}

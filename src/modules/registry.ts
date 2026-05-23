import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '../storage/db.js'
import type { EventBus } from '../core/events.js'
import type { StorageAdapter } from '../storage/adapter.js'
import { parseFrontmatter } from '../memory/wiki/frontmatter.js'
import { applyModuleMigrations, type Migration } from './migrations.js'
import type { AuditLog } from './audit-log.js'

export interface ModuleManifest {
  name: string
  description: string
  version: string
  dependsOn: string[]
  frontmatter: Record<string, unknown>
  body: string
}

export interface ModuleHandle {
  name: string
  manifest: ModuleManifest
  rootPath: string
  status: 'active' | 'degraded'
  degradedReason?: string
  /** Module-specific service instance (`unknown` here because each Module
   *  has its own typed surface; consumers cast). Present only when status
   *  is 'active' AND a factory was registered for this Module. */
  service?: unknown
}

export interface ModuleRegistry {
  get(name: string): ModuleHandle | undefined
  list(): ModuleHandle[]
}

export interface ModuleServiceContext {
  db: Db
  eventBus: EventBus
  audit: AuditLog
  storage: StorageAdapter
  /** Snapshot of modules booted so far — keyed by name. A factory may read
   *  from this to wire cross-module references (e.g. `email` reading the
   *  `projects` service). Modules later in topo order see modules earlier in
   *  the order; the registry is built up incrementally. */
  modules: ModuleRegistry
}

export type ModuleServiceFactory = (ctx: ModuleServiceContext) => unknown

export interface BootModulesOptions {
  db: Db
  /** Directory containing one folder per Module. */
  rootDir: string
  /** Optional service factories keyed by Module name. The factory runs only
   *  after migrations succeed; its return value becomes ModuleHandle.service.
   *  Modules without a factory still boot (manifest + migrations) but expose
   *  no service. */
  factories?: Record<string, ModuleServiceFactory>
  /** Required when any factory will be called — passed through to factories.
   *  Optional in tests that only exercise discovery/migration. */
  eventBus?: EventBus
  audit?: AuditLog
  storage?: StorageAdapter
}

export async function bootModules(opts: BootModulesOptions): Promise<ModuleRegistry> {
  const discovered = await discoverModules(opts.rootDir)
  const dependencyIssues = findDependencyIssues(discovered)
  const ordered = topoSort(discovered)
  const handles = new Map<string, ModuleHandle>()

  // Mutable view that factories can read during boot — see each module that
  // came before it in topo order.
  const registryView: ModuleRegistry = {
    get: (name) => handles.get(name),
    list: () => Array.from(handles.values()),
  }

  for (const d of ordered) {
    const manifestIssue = validateManifest(d.manifest)
    if (manifestIssue) {
      handles.set(d.manifest.name, {
        name: d.manifest.name,
        manifest: d.manifest,
        rootPath: d.rootPath,
        status: 'degraded',
        degradedReason: manifestIssue,
      })
      continue
    }
    const issue = dependencyIssues.get(d.manifest.name)
    if (issue) {
      handles.set(d.manifest.name, {
        name: d.manifest.name,
        manifest: d.manifest,
        rootPath: d.rootPath,
        status: 'degraded',
        degradedReason: issue,
      })
      continue
    }
    const migrations = await loadMigrations(d.rootPath)
    const result = applyModuleMigrations(opts.db, d.manifest.name, migrations)
    if (result.failed) {
      handles.set(d.manifest.name, {
        name: d.manifest.name,
        manifest: d.manifest,
        rootPath: d.rootPath,
        status: 'degraded',
        degradedReason: `migration v${result.failed.version} (${result.failed.name}) failed: ${result.failed.error}`,
      })
      continue
    }

    const handle: ModuleHandle = {
      name: d.manifest.name,
      manifest: d.manifest,
      rootPath: d.rootPath,
      status: 'active',
    }

    const factory = opts.factories?.[d.manifest.name]
    if (factory) {
      if (!opts.eventBus || !opts.audit || !opts.storage) {
        handle.status = 'degraded'
        handle.degradedReason = 'service factory present but service deps (eventBus/audit/storage) missing in bootModules call'
      } else {
        try {
          handle.service = factory({
            db: opts.db,
            eventBus: opts.eventBus,
            audit: opts.audit,
            storage: opts.storage,
            modules: registryView,
          })
        } catch (err) {
          handle.status = 'degraded'
          handle.degradedReason = `service factory threw: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    handles.set(d.manifest.name, handle)
  }

  return registryView
}

function validateManifest(manifest: ModuleManifest): string | null {
  const missing: string[] = []
  if (!manifest.description) missing.push('description')
  if (!manifest.frontmatter.version) missing.push('version')
  if (missing.length > 0) {
    return `MODULE.md is missing required field(s): ${missing.join(', ')}`
  }
  return null
}

function findDependencyIssues(modules: DiscoveredModule[]): Map<string, string> {
  const byName = new Map(modules.map((m) => [m.manifest.name, m]))
  const issues = new Map<string, string>()

  for (const m of modules) {
    const missing = m.manifest.dependsOn.filter((d) => !byName.has(d))
    if (missing.length > 0) {
      issues.set(
        m.manifest.name,
        `missing depends_on target(s): ${missing.join(', ')}`,
      )
    }
  }

  // Tarjan-lite: any module that can reach itself via dependsOn is in a cycle.
  // Module names involved in any cycle are flagged so the registry can mark
  // them degraded rather than silently dropping them out of the boot.
  const onStack = new Set<string>()
  const visited = new Set<string>()
  const inCycle = new Set<string>()
  function dfs(name: string): void {
    if (visited.has(name)) return
    onStack.add(name)
    const mod = byName.get(name)
    if (mod) {
      for (const dep of mod.manifest.dependsOn) {
        if (onStack.has(dep)) {
          // The cycle is everything currently on the stack from dep onward.
          let inside = false
          for (const s of onStack) {
            if (s === dep) inside = true
            if (inside) inCycle.add(s)
          }
        } else {
          dfs(dep)
        }
      }
    }
    onStack.delete(name)
    visited.add(name)
  }
  for (const m of modules) dfs(m.manifest.name)
  for (const name of inCycle) {
    if (!issues.has(name)) {
      issues.set(name, 'depends_on cycle detected')
    }
  }

  return issues
}

interface DiscoveredModule {
  manifest: ModuleManifest
  rootPath: string
}

async function discoverModules(rootDir: string): Promise<DiscoveredModule[]> {
  let entries: string[]
  try {
    entries = await readdir(rootDir)
  } catch {
    return []
  }
  const out: DiscoveredModule[] = []
  for (const entry of entries) {
    const moduleDir = join(rootDir, entry)
    const st = await stat(moduleDir).catch(() => null)
    if (!st || !st.isDirectory()) continue
    const manifestPath = join(moduleDir, 'MODULE.md')
    const raw = await readFile(manifestPath, 'utf-8').catch(() => null)
    if (raw === null) continue
    const parsed = parseFrontmatter(raw)
    const manifest = toManifest(entry, parsed.frontmatter, parsed.body)
    out.push({ manifest, rootPath: moduleDir })
  }
  return out
}

function toManifest(
  folderName: string,
  fm: Record<string, unknown>,
  body: string,
): ModuleManifest {
  const name = typeof fm.name === 'string' && fm.name.length > 0 ? fm.name : folderName
  const description = typeof fm.description === 'string' ? fm.description : ''
  const version = typeof fm.version === 'string' ? fm.version : '0.0.0'
  const dependsOn = Array.isArray(fm.depends_on)
    ? fm.depends_on.filter((d): d is string => typeof d === 'string')
    : []
  return { name, description, version, dependsOn, frontmatter: fm, body }
}

function topoSort(modules: DiscoveredModule[]): DiscoveredModule[] {
  const byName = new Map(modules.map((m) => [m.manifest.name, m]))
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const out: DiscoveredModule[] = []

  function visit(name: string): void {
    if (visited.has(name)) return
    if (visiting.has(name)) return
    const mod = byName.get(name)
    if (!mod) return
    visiting.add(name)
    for (const dep of mod.manifest.dependsOn) {
      visit(dep)
    }
    visiting.delete(name)
    visited.add(name)
    out.push(mod)
  }

  for (const m of modules) visit(m.manifest.name)
  return out
}

async function loadMigrations(moduleRoot: string): Promise<Migration[]> {
  const schemaDir = join(moduleRoot, 'schema')
  let files: string[]
  try {
    files = await readdir(schemaDir)
  } catch {
    return []
  }
  const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort()
  const out: Migration[] = []
  for (const file of sqlFiles) {
    const match = file.match(/^(\d+)_(.+)\.sql$/)
    if (!match) continue
    const version = Number(match[1])
    const name = `${match[1]}_${match[2]}`
    const sql = await readFile(join(schemaDir, file), 'utf-8')
    out.push({ version, name, sql })
  }
  return out
}

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  SkillFrontmatterSchema,
  CategoryFrontmatterSchema,
  RESERVED_SLASH_COMMANDS,
  type SkillFrontmatter,
  type CategoryFrontmatter,
} from './frontmatter.js'
import { parseFrontmatter } from '../memory/wiki/frontmatter.js'
import type { ToolModule } from './tool.js'

export interface SkillManifest {
  /** Canonical skill name = `<category>/<skill-name>`. */
  qualifiedName: string
  category: string
  name: string
  description: string
  frontmatter: SkillFrontmatter
  body: string
  /** Absolute path of the skill folder. */
  folder: string
  /** Absolute path of SKILL.md. */
  skillMdPath: string
  slashCommand: string | null
}

export interface CategoryManifest {
  name: string
  description: string
  /** Absolute path of the category folder. */
  folder: string
}

export interface SkillIndex {
  skills: Map<string, SkillManifest>
  categories: Map<string, CategoryManifest>
  bySlashCommand: Map<string, SkillManifest>
}

export class SkillLoadError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_FRONTMATTER'
      | 'MISSING_HANDLER'
      | 'SLASH_COLLISION'
      | 'DUPLICATE_SKILL'
      | 'IO',
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'SkillLoadError'
  }
}

export interface LoadSkillsOptions {
  /** Absolute path to the skills directory. */
  root: string
  /** Additional Module-scoped skill roots. Each entry's subdirs are scanned
   *  one level deep for SKILL.md and registered with qualifiedName
   *  `<module>/<skill-name>` ([[adr-0004]] modules-as-second-primitive). */
  moduleSkillRoots?: Array<{ module: string; root: string }>
}

/**
 * Scan `<root>/<category>/<skill>/SKILL.md` files, parse and validate each,
 * read the matching `CATEGORY.md` for category descriptions, and build the
 * in-memory index. Handler modules are NOT imported here — they are imported
 * lazily on `load_skill` to keep startup cheap and surface bad modules only
 * when a session actually loads the skill.
 */
export async function loadSkillIndex(opts: LoadSkillsOptions): Promise<SkillIndex> {
  if (!isAbsolute(opts.root)) {
    throw new SkillLoadError(`Skills root must be absolute: ${opts.root}`, 'IO')
  }

  const skills = new Map<string, SkillManifest>()
  const categories = new Map<string, CategoryManifest>()
  const bySlashCommand = new Map<string, SkillManifest>()

  const rootExists = await pathExists(opts.root)
  if (!rootExists) return { skills, categories, bySlashCommand }

  const categoryEntries = await readdir(opts.root, { withFileTypes: true })
  for (const catEnt of categoryEntries) {
    if (!catEnt.isDirectory()) continue
    const categoryFolder = join(opts.root, catEnt.name)
    const category = await readCategory(categoryFolder, catEnt.name)
    if (category) categories.set(category.name, category)
    await loadSkillsFromDir(categoryFolder, catEnt.name, skills, bySlashCommand)
  }

  for (const modRoot of opts.moduleSkillRoots ?? []) {
    if (!(await pathExists(modRoot.root))) continue
    await loadSkillsFromDir(modRoot.root, modRoot.module, skills, bySlashCommand)
  }

  return { skills, categories, bySlashCommand }
}

async function loadSkillsFromDir(
  parentFolder: string,
  qualifier: string,
  skills: Map<string, SkillManifest>,
  bySlashCommand: Map<string, SkillManifest>,
): Promise<void> {
  const skillEntries = await readdir(parentFolder, { withFileTypes: true })
  for (const skillEnt of skillEntries) {
    if (!skillEnt.isDirectory()) continue
    const skillFolder = join(parentFolder, skillEnt.name)
    const skillMdPath = join(skillFolder, 'SKILL.md')
    if (!(await pathExists(skillMdPath))) continue
    const manifest = await readSkill(skillMdPath, qualifier, skillFolder)
    if (skills.has(manifest.qualifiedName)) {
      throw new SkillLoadError(
        `Duplicate skill name: ${manifest.qualifiedName}`,
        'DUPLICATE_SKILL',
      )
    }
    if (manifest.slashCommand) {
      if (RESERVED_SLASH_COMMANDS.has(manifest.slashCommand)) {
        throw new SkillLoadError(
          `Skill ${manifest.qualifiedName} uses reserved slash_command "${manifest.slashCommand}"`,
          'SLASH_COLLISION',
        )
      }
      const existing = bySlashCommand.get(manifest.slashCommand)
      if (existing) {
        throw new SkillLoadError(
          `slash_command "${manifest.slashCommand}" claimed by ${existing.qualifiedName} and ${manifest.qualifiedName}`,
          'SLASH_COLLISION',
        )
      }
      bySlashCommand.set(manifest.slashCommand, manifest)
    }
    skills.set(manifest.qualifiedName, manifest)
  }
}

async function readCategory(
  folder: string,
  fallbackName: string,
): Promise<CategoryManifest | null> {
  const path = join(folder, 'CATEGORY.md')
  if (!(await pathExists(path))) return null
  const raw = await readFile(path, 'utf-8')
  const parsed = parseFrontmatter(raw)
  const validation = CategoryFrontmatterSchema.safeParse(parsed.frontmatter)
  if (!validation.success) {
    throw new SkillLoadError(
      `Invalid CATEGORY.md at ${path}: ${validation.error.message}`,
      'INVALID_FRONTMATTER',
      validation.error,
    )
  }
  const data: CategoryFrontmatter = validation.data
  if (data.name !== fallbackName) {
    throw new SkillLoadError(
      `CATEGORY.md name "${data.name}" must match folder name "${fallbackName}"`,
      'INVALID_FRONTMATTER',
    )
  }
  return { name: data.name, description: data.description, folder }
}

async function readSkill(
  skillMdPath: string,
  category: string,
  folder: string,
): Promise<SkillManifest> {
  const raw = await readFile(skillMdPath, 'utf-8')
  const parsed = parseFrontmatter(raw)
  const validation = SkillFrontmatterSchema.safeParse(parsed.frontmatter)
  if (!validation.success) {
    throw new SkillLoadError(
      `Invalid SKILL.md frontmatter at ${skillMdPath}: ${validation.error.message}`,
      'INVALID_FRONTMATTER',
      validation.error,
    )
  }
  const fm: SkillFrontmatter = validation.data
  const folderName = folder.split(sep).pop()
  if (fm.name !== folderName) {
    throw new SkillLoadError(
      `SKILL.md name "${fm.name}" must match folder name "${folderName}" (at ${skillMdPath})`,
      'INVALID_FRONTMATTER',
    )
  }

  if (fm.tools) {
    for (const tool of fm.tools) {
      const abs = resolve(folder, tool.handler)
      if (!(await pathExists(abs))) {
        throw new SkillLoadError(
          `Tool handler not found: ${tool.handler} (resolved to ${abs}) for ${category}/${fm.name}`,
          'MISSING_HANDLER',
        )
      }
    }
  }

  return {
    qualifiedName: `${category}/${fm.name}`,
    category,
    name: fm.name,
    description: fm.description,
    frontmatter: fm,
    body: parsed.body,
    folder,
    skillMdPath,
    slashCommand: fm.slash_command ?? null,
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      return false
    }
    throw err
  }
}

export interface LoadedSkillTool {
  id: string
  description: string
  module: ToolModule
  handlerPath: string
}

/**
 * Lazily import a skill's declared tool handler modules. Called by
 * `load_skill` on demand. The returned module's `parameters` (Zod schema)
 * gets registered with the orchestrator's ToolRegistry for the session.
 */
export async function importSkillTools(
  manifest: SkillManifest,
): Promise<LoadedSkillTool[]> {
  if (!manifest.frontmatter.tools || manifest.frontmatter.tools.length === 0) {
    return []
  }
  const out: LoadedSkillTool[] = []
  for (const decl of manifest.frontmatter.tools) {
    const abs = resolve(manifest.folder, decl.handler)
    const url = pathToFileURL(abs).href
    let mod: Record<string, unknown>
    try {
      mod = (await import(url)) as Record<string, unknown>
    } catch (err) {
      throw new SkillLoadError(
        `Failed to import handler ${decl.handler} for ${manifest.qualifiedName}`,
        'MISSING_HANDLER',
        err,
      )
    }
    const candidate = pickToolModule(mod)
    if (!candidate) {
      throw new SkillLoadError(
        `Handler ${decl.handler} for ${manifest.qualifiedName} must export { parameters, handler }`,
        'MISSING_HANDLER',
      )
    }
    out.push({
      id: decl.id,
      description: decl.description,
      module: candidate,
      handlerPath: abs,
    })
  }
  return out
}

function pickToolModule(mod: Record<string, unknown>): ToolModule | null {
  if (isToolModule(mod.default)) return mod.default
  if (isToolModule(mod)) return mod
  return null
}

function isToolModule(value: unknown): value is ToolModule {
  if (!value || typeof value !== 'object') return false
  const v = value as { parameters?: unknown; handler?: unknown }
  return (
    typeof v.handler === 'function' &&
    v.parameters !== undefined &&
    v.parameters !== null
  )
}

/** Convenience for tests/debugging — render the index as a list. */
export function describeSkillIndex(idx: SkillIndex): string {
  const parts: string[] = []
  for (const cat of idx.categories.values()) {
    parts.push(`${cat.name}: ${cat.description}`)
  }
  for (const s of idx.skills.values()) {
    parts.push(`${s.qualifiedName}: ${s.description}`)
  }
  return parts.join('\n')
}

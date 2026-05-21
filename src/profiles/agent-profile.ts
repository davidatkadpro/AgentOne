import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import yaml from 'js-yaml'

const PermissionsSchema = z
  .object({
    skills: z
      .object({
        allow: z.array(z.string()).default([]),
        deny: z.array(z.string()).default([]),
      })
      .default({ allow: [], deny: [] }),
    experts: z
      .object({
        allow: z.array(z.string()).default([]),
        budget_per_call_usd: z.number().nonnegative().optional(),
        budget_per_session_usd: z.number().nonnegative().optional(),
      })
      .default({ allow: [] }),
  })
  .default({
    skills: { allow: [], deny: [] },
    experts: { allow: [] },
  })

const PassiveRecallSchema = z
  .object({
    enabled: z.boolean().default(false),
    wiki_hits: z.number().int().nonnegative().max(10).default(2),
    history_hits: z.number().int().nonnegative().max(10).default(2),
    max_chars_per_hit: z.number().int().positive().max(2000).default(240),
  })
  .optional()

const AutoDistillSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Minutes of inactivity before a session is eligible for auto-distill. */
    idle_minutes: z.number().int().positive().max(7 * 24 * 60).default(30),
    /** Background scan frequency in minutes. Defaults to idle_minutes / 6,
     *  clamped to [1, 30]. Lower = more responsive, higher = less load. */
    scan_interval_minutes: z.number().int().positive().max(60).optional(),
  })
  .optional()

const AgentProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  description: z.string().optional(),
  extends: z.string().optional(),
  system_prompt_file: z.string().optional(),
  // Optional here so a child profile can inherit it from its base.
  // The resolver enforces that one of {child, base} supplies it.
  default_model: z.string().optional(),
  compressor_model: z.string().optional(),
  default_skills: z.array(z.string()).default([]),
  permissions: PermissionsSchema,
  passive_recall: PassiveRecallSchema,
  auto_distill: AutoDistillSchema,
  /**
   * Tool-id patterns that this profile is not permitted to call. Wired
   * through the HookRegistry as a pre-hook so denied calls surface as a
   * recoverable PERMISSION_DENIED to the agent (not a hard failure).
   * Complements permissions.skills.deny (which gates skill *loading*).
   */
  deny_tools: z.array(z.string()).default([]),
})

export type RawAgentProfile = z.infer<typeof AgentProfileSchema>

export interface ResolvedAgentProfile {
  id: string
  description?: string
  systemPromptFile: string | null
  defaultModel: string
  compressorModel: string | null
  defaultSkills: string[]
  permissions: {
    skills: { allow: string[]; deny: string[] }
    experts: {
      allow: string[]
      budgetPerCallUsd: number | null
      budgetPerSessionUsd: number | null
    }
  }
  passiveRecall: {
    enabled: boolean
    wikiHits: number
    historyHits: number
    maxCharsPerHit: number
  }
  autoDistill: {
    enabled: boolean
    idleMinutes: number
    scanIntervalMinutes: number
  }
  /** Tool-id deny patterns (union of base + child). See HookRegistry.matchesToolId. */
  denyTools: string[]
  /** Where the profile YAML file lives — used to resolve relative paths. */
  sourceFile: string
}

export class AgentProfileError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INVALID' | 'CIRCULAR_EXTENDS' | 'EXTENDS_NOT_FOUND',
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AgentProfileError'
  }
}

async function readRaw(path: string): Promise<RawAgentProfile> {
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    throw new AgentProfileError(`Profile not found: ${path}`, 'NOT_FOUND', err)
  }
  const parsed = yaml.load(text)
  const validation = AgentProfileSchema.safeParse(parsed)
  if (!validation.success) {
    throw new AgentProfileError(
      `Invalid agent profile at ${path}: ${validation.error.message}`,
      'INVALID',
      validation.error,
    )
  }
  return validation.data
}

/**
 * Load and resolve an agent profile, applying single-level `extends` merge.
 * The merge rules (NACL-style):
 *
 *   defaultSkills:     child REPLACES base if non-empty, else inherits
 *   default_model:     child REPLACES base
 *   permissions.allow: union(base, child)
 *   permissions.deny:  union(base, child)
 */
export async function loadAgentProfile(
  profilesDir: string,
  id: string,
): Promise<ResolvedAgentProfile> {
  const path = resolve(profilesDir, `${id}.yaml`)
  const raw = await readRaw(path)

  let base: RawAgentProfile | null = null
  let basePath: string | null = null
  if (raw.extends) {
    if (raw.extends === id) {
      throw new AgentProfileError(
        `Profile ${id} extends itself`,
        'CIRCULAR_EXTENDS',
      )
    }
    basePath = resolve(profilesDir, `${raw.extends}.yaml`)
    try {
      base = await readRaw(basePath)
    } catch (err) {
      if (err instanceof AgentProfileError && err.code === 'NOT_FOUND') {
        throw new AgentProfileError(
          `Base profile not found: ${raw.extends} (referenced by ${id})`,
          'EXTENDS_NOT_FOUND',
          err,
        )
      }
      throw err
    }
    // Reject multi-level inheritance: the base must not itself extend another
    // profile. Single-level only (PRD Q5b).
    if (base.extends) {
      throw new AgentProfileError(
        `Multi-level extends not allowed: ${raw.extends} extends ${base.extends}`,
        'INVALID',
      )
    }
  }

  const defaultModel = raw.default_model ?? base?.default_model
  if (!defaultModel) {
    throw new AgentProfileError(
      `Profile ${id} has no default_model (and no base supplies one)`,
      'INVALID',
    )
  }

  const systemPromptFile =
    raw.system_prompt_file ?? base?.system_prompt_file ?? null

  const compressorModel = raw.compressor_model ?? base?.compressor_model ?? null

  const defaultSkills =
    raw.default_skills.length > 0
      ? raw.default_skills
      : (base?.default_skills ?? [])

  const allowSkills = mergeUnique(
    base?.permissions?.skills?.allow ?? [],
    raw.permissions.skills.allow,
  )
  const denySkills = mergeUnique(
    base?.permissions?.skills?.deny ?? [],
    raw.permissions.skills.deny,
  )
  const allowExperts = mergeUnique(
    base?.permissions?.experts?.allow ?? [],
    raw.permissions.experts.allow,
  )

  // Passive recall: child replaces base entirely when it specifies the
  // block; otherwise inherit. Defaults stay disabled-off so a profile
  // that omits it gets zero overhead.
  const rawRecall = raw.passive_recall ?? base?.passive_recall
  const passiveRecall = {
    enabled: rawRecall?.enabled ?? false,
    wikiHits: rawRecall?.wiki_hits ?? 2,
    historyHits: rawRecall?.history_hits ?? 2,
    maxCharsPerHit: rawRecall?.max_chars_per_hit ?? 240,
  }

  // deny_tools: union of base + child. Same merge semantics as
  // permissions.skills.deny — opt-out only stacks, you cannot un-deny
  // something a base profile prohibited.
  const denyTools = mergeUnique(base?.deny_tools ?? [], raw.deny_tools)

  // auto_distill: child replaces base entirely when present, else inherit.
  // Default scan interval is idle/6 capped to [1, 30] so the scan frequency
  // scales with the idle threshold instead of being fixed.
  const rawDistill = raw.auto_distill ?? base?.auto_distill
  const distillIdleMinutes = rawDistill?.idle_minutes ?? 30
  const distillScanInterval =
    rawDistill?.scan_interval_minutes ?? clamp(Math.floor(distillIdleMinutes / 6), 1, 30)
  const autoDistill = {
    enabled: rawDistill?.enabled ?? false,
    idleMinutes: distillIdleMinutes,
    scanIntervalMinutes: distillScanInterval,
  }

  return {
    id: raw.id,
    ...(raw.description !== undefined && { description: raw.description }),
    systemPromptFile: systemPromptFile
      ? resolve(dirname(path), systemPromptFile)
      : null,
    defaultModel,
    compressorModel,
    defaultSkills,
    permissions: {
      skills: { allow: allowSkills, deny: denySkills },
      experts: {
        allow: allowExperts,
        budgetPerCallUsd: raw.permissions.experts.budget_per_call_usd ?? null,
        budgetPerSessionUsd: raw.permissions.experts.budget_per_session_usd ?? null,
      },
    },
    passiveRecall,
    autoDistill,
    denyTools,
    sourceFile: path,
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set<string>()
  for (const v of a) set.add(v)
  for (const v of b) set.add(v)
  return [...set]
}

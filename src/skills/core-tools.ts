import { z } from 'zod'
import type { RegisteredTool } from './tool.js'
import { fail, ok } from './tool.js'
import type { SkillIndex, SkillManifest } from './loader.js'
import { importSkillTools, SkillLoadError } from './loader.js'
import type { ToolRegistry } from './registry.js'
import type { PermissionGate } from '../profiles/permission-gate.js'
import { EventBus } from '../core/events.js'

const ListSkillsParams = z.object({
  category: z.string().optional().describe('Filter to a single category'),
  query: z
    .string()
    .optional()
    .describe('Case-insensitive substring filter over skill name + description'),
})

const LoadSkillParams = z.object({
  name: z.string().describe('Skill qualified name, e.g. "research/web-deep-dive"'),
})

export interface CoreSkillToolsContext {
  index: SkillIndex
  registry: ToolRegistry
  permissions: PermissionGate
  bus: EventBus
  sessionId: string
  /** Names of skills already loaded in this session. */
  loadedSkills: Set<string>
}

/**
 * Constructs the two skill-discovery Core Tools for a session. They close
 * over per-session state (which skills are already loaded, the session id,
 * the session's tool registry) so each session sees a fresh view.
 */
export function buildCoreSkillTools(ctx: CoreSkillToolsContext): RegisteredTool[] {
  const listSkills: RegisteredTool = {
    id: 'list_skills',
    description:
      'List discoverable skills. Filter by category or substring query. Returns name, description, category, and whether the skill is currently loaded.',
    parameters: ListSkillsParams,
    handler: async (args) => {
      const filtered = filterSkills(ctx.index, args)
      const items = filtered.map((s) => ({
        name: s.qualifiedName,
        category: s.category,
        description: s.description,
        loaded: ctx.loadedSkills.has(s.qualifiedName),
        slash_command: s.slashCommand,
      }))
      return ok({ skills: items, count: items.length })
    },
    source: 'core',
  }

  const loadSkill: RegisteredTool = {
    id: 'load_skill',
    description:
      'Load a skill by qualified name. Returns the full SKILL.md body and registers any tools the skill declares. Subsequent tool calls in this session can use those tools.',
    parameters: LoadSkillParams,
    handler: async (args) => {
      const manifest = ctx.index.skills.get(args.name)
      if (!manifest) {
        return fail('TOOL_VALIDATION', `No skill found: ${args.name}`, true)
      }
      const decision = ctx.permissions.canLoadSkill(args.name)
      if (decision.verdict === 'deny') {
        return fail(
          'PERMISSION_DENIED',
          `Profile forbids loading ${args.name}: ${decision.reason}`,
          false,
        )
      }
      if (ctx.loadedSkills.has(args.name)) {
        return ok({ already_loaded: true, body: manifest.body })
      }

      const needed = manifest.frontmatter['allowed-tools'] ?? []
      const missing = needed.filter((id) => !ctx.registry.has(id))
      if (missing.length > 0) {
        return fail(
          'SKILL_LOAD_FAILED',
          `Skill ${args.name} requires tools not currently registered: ${missing.join(', ')}`,
          false,
        )
      }

      await ctx.bus.emit({
        type: 'skill.loading',
        sessionId: ctx.sessionId,
        name: args.name,
        ts: Date.now(),
      })

      let imported: Awaited<ReturnType<typeof importSkillTools>>
      try {
        imported = await importSkillTools(manifest)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        await ctx.bus.emit({
          type: 'skill.load_failed',
          sessionId: ctx.sessionId,
          name: args.name,
          reason,
          ts: Date.now(),
        })
        return fail(
          'SKILL_LOAD_FAILED',
          `Failed to import handlers for ${args.name}: ${reason}`,
          err instanceof SkillLoadError && err.code === 'IO',
        )
      }

      for (const t of imported) {
        if (ctx.registry.has(t.id)) {
          await ctx.bus.emit({
            type: 'skill.load_failed',
            sessionId: ctx.sessionId,
            name: args.name,
            reason: `tool id collision: ${t.id}`,
            ts: Date.now(),
          })
          return fail(
            'SKILL_LOAD_FAILED',
            `Tool id "${t.id}" from ${args.name} collides with an already-registered tool`,
            false,
          )
        }
        ctx.registry.register({
          id: t.id,
          description: t.description,
          parameters: t.module.parameters,
          handler: t.module.handler,
          source: args.name,
        })
      }

      ctx.loadedSkills.add(args.name)
      await ctx.bus.emit({
        type: 'skill.loaded',
        sessionId: ctx.sessionId,
        name: args.name,
        toolsRegistered: imported.map((t) => t.id),
        ts: Date.now(),
      })

      return ok({
        name: args.name,
        tools_registered: imported.map((t) => t.id),
        body: manifest.body,
      })
    },
    source: 'core',
  }

  return [listSkills, loadSkill]
}

function filterSkills(
  index: SkillIndex,
  args: { category?: string; query?: string },
): SkillManifest[] {
  const all = [...index.skills.values()]
  let result = all
  if (args.category) {
    result = result.filter((s) => s.category === args.category)
  }
  if (args.query) {
    const q = args.query.toLowerCase()
    result = result.filter(
      (s) =>
        s.qualifiedName.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    )
  }
  return result
}

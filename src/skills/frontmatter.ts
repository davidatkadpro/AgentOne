import { z } from 'zod'

const KEBAB = /^[a-z0-9-]+$/
const IDENT = /^[a-z][a-z0-9_-]*$/

export const ToolDeclaration = z.object({
  // Tool ids follow OpenAI's function-name convention: lowercase, alphanumeric,
  // plus underscore or hyphen. We allow either separator so authors can match
  // their language's idiomatic style.
  id: z.string().regex(IDENT, 'tool id must be lowercase identifier (a-z, 0-9, _, -)'),
  handler: z.string().min(1),
  description: z.string().min(1),
})

export const SkillFrontmatterSchema = z.object({
  name: z.string().regex(KEBAB, 'skill name must be kebab-case'),
  description: z.string().min(1),
  tools: z.array(ToolDeclaration).optional(),
  'allowed-tools': z.array(z.string()).optional(),
  slash_command: z.string().regex(KEBAB).optional(),
  docs: z.array(z.string()).optional(),
  version: z.string().optional(),
})

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

export const CategoryFrontmatterSchema = z.object({
  name: z.string().regex(KEBAB),
  description: z.string().min(1),
})

export type CategoryFrontmatter = z.infer<typeof CategoryFrontmatterSchema>

/**
 * Names reserved for System Commands handled server-side. A Skill whose
 * `slash_command` collides with these is rejected at load time so the
 * slash namespace stays unambiguous.
 */
export const RESERVED_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  'new',
  'help',
  'load',
  'compact',
  'sessions',
  'clear',
  'cost',
])

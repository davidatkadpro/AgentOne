import { z } from 'zod'
import type { RegisteredTool, ToolHandler } from './tool.js'
import { fail, ok } from './tool.js'
import { StorageError } from '../storage/adapter.js'

const WikiReadParams = z.object({
  path: z.string().describe('Wiki path. Either canonical (projects/agentone) or with .md.'),
})

const WikiWriteParams = z.object({
  path: z.string(),
  content: z.string().describe('Full markdown content including frontmatter if any.'),
})

const WikiAppendParams = z.object({
  path: z.string(),
  content: z.string().describe('Text to append to the page body (frontmatter preserved).'),
})

const WikiEditParams = z.object({
  path: z.string(),
  find: z.string().min(1).describe('Exact substring to replace. Must appear exactly once.'),
  replace: z.string(),
})

const WikiSearchParams = z.object({
  query: z.string().min(1),
  prefix: z.string().optional(),
  limit: z.number().int().positive().max(50).default(10),
  offset: z.number().int().nonnegative().default(0),
})

const WikiBacklinksParams = z.object({
  path: z.string(),
})

/**
 * Six wiki Core Tools that wrap the WikiEngine. These are always registered
 * for every session — the wiki is the agent's memory substrate, not an
 * optional capability.
 */
export function buildWikiCoreTools(): RegisteredTool[] {
  const wikiRead: ToolHandler<typeof WikiReadParams> = async (args, ctx) => {
    try {
      const page = await ctx.services.wiki.read(args.path)
      if (!page) {
        return fail('RESOURCE_UNAVAILABLE', `Wiki page not found: ${args.path}`, true)
      }
      return ok({
        path: page.path,
        name: page.name,
        body: page.body,
        frontmatter: page.frontmatter,
        updated_at: page.updatedAt.toISOString(),
      })
    } catch (err) {
      return wrapError(err)
    }
  }

  const wikiWrite: ToolHandler<typeof WikiWriteParams> = async (args, ctx) => {
    try {
      const page = await ctx.services.wiki.write(args.path, args.content)
      return ok({ path: page.path, name: page.name, size_bytes: page.raw.length })
    } catch (err) {
      return wrapError(err)
    }
  }

  const wikiAppend: ToolHandler<typeof WikiAppendParams> = async (args, ctx) => {
    try {
      const page = await ctx.services.wiki.append(args.path, args.content)
      return ok({ path: page.path, name: page.name })
    } catch (err) {
      return wrapError(err)
    }
  }

  const wikiEdit: ToolHandler<typeof WikiEditParams> = async (args, ctx) => {
    try {
      const page = await ctx.services.wiki.edit(args.path, args.find, args.replace)
      return ok({ path: page.path, name: page.name })
    } catch (err) {
      return wrapError(err)
    }
  }

  const wikiSearch: ToolHandler<typeof WikiSearchParams> = async (args, ctx) => {
    try {
      const opts: { prefix?: string; limit?: number; offset?: number } = {
        limit: args.limit,
        offset: args.offset,
      }
      if (args.prefix !== undefined) opts.prefix = args.prefix
      const hits = await ctx.services.wiki.search(args.query, opts)
      return ok({ count: hits.length, hits })
    } catch (err) {
      return wrapError(err)
    }
  }

  const wikiBacklinks: ToolHandler<typeof WikiBacklinksParams> = async (args, ctx) => {
    try {
      const hits = await ctx.services.wiki.backlinks(args.path)
      return ok({ count: hits.length, hits })
    } catch (err) {
      return wrapError(err)
    }
  }

  return [
    {
      id: 'wiki_read',
      description: 'Read a wiki page. Returns content, frontmatter, and metadata.',
      parameters: WikiReadParams,
      handler: wikiRead as ToolHandler,
      source: 'core',
    },
    {
      id: 'wiki_write',
      description:
        'Overwrite a wiki page with the given full content (frontmatter optional). Use wiki_append/wiki_edit for incremental changes.',
      parameters: WikiWriteParams,
      handler: wikiWrite as ToolHandler,
      source: 'core',
    },
    {
      id: 'wiki_append',
      description: 'Append text to a wiki page body. Creates the page if missing.',
      parameters: WikiAppendParams,
      handler: wikiAppend as ToolHandler,
      source: 'core',
    },
    {
      id: 'wiki_edit',
      description:
        'Replace exactly one occurrence of a find-string in an existing wiki page. Errors if zero or multiple matches.',
      parameters: WikiEditParams,
      handler: wikiEdit as ToolHandler,
      source: 'core',
    },
    {
      id: 'wiki_search',
      description: 'Full-text search the wiki. Returns ranked hits with snippets.',
      parameters: WikiSearchParams,
      handler: wikiSearch as ToolHandler,
      source: 'core',
    },
    {
      id: 'wiki_backlinks',
      description: 'List wiki pages that link to the given page (by path or by frontmatter name).',
      parameters: WikiBacklinksParams,
      handler: wikiBacklinks as ToolHandler,
      source: 'core',
    },
  ]
}

function wrapError(err: unknown) {
  if (err instanceof StorageError) {
    if (err.code === 'NOT_FOUND') return fail('RESOURCE_UNAVAILABLE', err.message, true)
    if (err.code === 'INVALID_PATH') return fail('TOOL_VALIDATION', err.message, true)
    if (err.code === 'PRECONDITION') return fail('TOOL_VALIDATION', err.message, true)
  }
  return fail('TOOL_RUNTIME', err instanceof Error ? err.message : String(err), false)
}

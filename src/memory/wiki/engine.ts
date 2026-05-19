import type { Db, NamedStmt, PositionalStmt } from '../../storage/db.js'
import type { StorageAdapter } from '../../storage/adapter.js'
import { StorageError } from '../../storage/adapter.js'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js'
import { extractLinks, canonicalisePath, type ParsedLink } from './links.js'
import { applyWikiSchema } from './schema.js'

export interface WikiPage {
  path: string
  name: string
  body: string
  frontmatter: Record<string, unknown>
  raw: string
  updatedAt: Date
}

export interface WikiSearchHit {
  path: string
  name: string
  snippet: string
}

export interface WikiSearchOpts {
  prefix?: string
  limit?: number
  offset?: number
}

export interface WikiEngineConfig {
  storage: StorageAdapter
  db: Db
  /** Subdirectory of storage root, e.g. "wiki". Defaults to "wiki". */
  prefix?: string
  /** Skip the startup reindex (tests that prime fixtures directly). */
  skipInitialReindex?: boolean
}

interface UpsertParams extends Record<string, unknown> {
  path: string
  name: string
  body: string
  frontmatter_json: string
  size: number
  updated_at: number
}

interface IndexedPage {
  canonical: string
  name: string
  body: string
  frontmatter: Record<string, unknown>
  size: number
  mtime: Date
  links: ParsedLink[]
}

const DEFAULT_SEARCH_LIMIT = 10
const REINDEX_READ_CONCURRENCY = 16

/**
 * Karpathy-style wiki: markdown files under `<prefix>/` with `[[Name]]` and
 * `[[path/to/page]]` links. The filesystem is the source of truth; this engine
 * maintains a SQLite index (FTS5 + backlink table) derived from filesystem
 * contents.
 *
 *  - Path identity is canonical. `name:` frontmatter is a humane alias resolved
 *    via the index; renames keep `[[Name]]` links valid as long as the name
 *    stays the same.
 *  - Frontmatter is optional. When present, an H1 may still serve as the
 *    display title.
 */
export class WikiEngine {
  private readonly prefix: string
  private ready: Promise<void>

  private readonly upsertPage: NamedStmt<UpsertParams>
  private readonly selectByPath: PositionalStmt
  private readonly selectByName: PositionalStmt
  private readonly deleteLinksFrom: PositionalStmt
  private readonly insertLink: PositionalStmt
  private readonly selectBacklinksMulti: PositionalStmt
  private readonly deleteFtsForPath: PositionalStmt
  private readonly insertFts: PositionalStmt
  private readonly searchFts: PositionalStmt
  private readonly searchFtsByPrefix: PositionalStmt

  constructor(private readonly cfg: WikiEngineConfig) {
    this.prefix = cfg.prefix ?? 'wiki'
    applyWikiSchema(cfg.db)

    this.upsertPage = cfg.db.prepare<UpsertParams>(`
      INSERT INTO wiki_pages (path, name, body, frontmatter_json, size, updated_at)
      VALUES (@path, @name, @body, @frontmatter_json, @size, @updated_at)
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name,
        body = excluded.body,
        frontmatter_json = excluded.frontmatter_json,
        size = excluded.size,
        updated_at = excluded.updated_at
    `)
    this.selectByPath = cfg.db.prepare<unknown[]>('SELECT * FROM wiki_pages WHERE path = ?')
    this.selectByName = cfg.db.prepare<unknown[]>(
      'SELECT path FROM wiki_pages WHERE name = ? LIMIT 1',
    )
    this.deleteLinksFrom = cfg.db.prepare<unknown[]>(
      'DELETE FROM wiki_links WHERE from_path = ?',
    )
    this.insertLink = cfg.db.prepare<unknown[]>(
      'INSERT OR IGNORE INTO wiki_links (from_path, to_path, kind, link_text) VALUES (?, ?, ?, ?)',
    )
    // Two targets (canonical path + optional name) selected in one round-trip.
    // Using IN with two placeholders means we always bind two values; we pass
    // the path twice when there's no separate name.
    this.selectBacklinksMulti = cfg.db.prepare<unknown[]>(`
      SELECT DISTINCT p.path, p.name, substr(p.body, 1, 240) AS snippet
      FROM wiki_links l
      JOIN wiki_pages p ON p.path = l.from_path
      WHERE l.to_path IN (?, ?)
      ORDER BY p.updated_at DESC
    `)
    this.deleteFtsForPath = cfg.db.prepare<unknown[]>(
      'DELETE FROM wiki_pages_fts WHERE path = ?',
    )
    this.insertFts = cfg.db.prepare<unknown[]>(
      'INSERT INTO wiki_pages_fts (path, name, body) VALUES (?, ?, ?)',
    )
    this.searchFts = cfg.db.prepare<unknown[]>(`
      SELECT path, name, snippet(wiki_pages_fts, 2, '', '', '…', 16) AS snippet
      FROM wiki_pages_fts
      WHERE wiki_pages_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `)
    this.searchFtsByPrefix = cfg.db.prepare<unknown[]>(`
      SELECT path, name, snippet(wiki_pages_fts, 2, '', '', '…', 16) AS snippet
      FROM wiki_pages_fts
      WHERE wiki_pages_fts MATCH ? AND path LIKE ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `)

    this.ready = cfg.skipInitialReindex ? Promise.resolve() : this.reindex()
  }

  whenReady(): Promise<void> {
    return this.ready
  }

  async read(path: string): Promise<WikiPage | null> {
    const canonical = canonicalisePath(path)
    const storagePath = this.toStoragePath(canonical)
    try {
      const result = await this.cfg.storage.read(storagePath)
      const text = result.content.toString('utf-8')
      const parsed = parseFrontmatter(text)
      const name = readName(parsed.frontmatter) ?? deriveName(canonical)
      return {
        path: canonical,
        name,
        body: parsed.body,
        frontmatter: parsed.frontmatter,
        raw: parsed.raw,
        updatedAt: result.mtime,
      }
    } catch (err) {
      if (err instanceof StorageError && err.code === 'NOT_FOUND') return null
      throw err
    }
  }

  async write(path: string, content: string): Promise<WikiPage> {
    return this.persist(path, content)
  }

  async append(path: string, addition: string): Promise<WikiPage> {
    const existing = await this.read(path)
    if (!existing) {
      return this.persist(path, addition)
    }
    const trimmedExisting = existing.body.replace(/\s+$/, '')
    const trimmedAddition = addition.replace(/^\s+/, '')
    const newBody = `${trimmedExisting}\n\n${trimmedAddition}`
    return this.persist(path, serializeFrontmatter(existing.frontmatter, newBody))
  }

  /**
   * Surgical replace. `find` must appear exactly once in the body — zero or
   * multiple matches are PRECONDITION failures so that edits are unambiguous.
   */
  async edit(path: string, find: string, replace: string): Promise<WikiPage> {
    const existing = await this.read(path)
    if (!existing) {
      throw new StorageError(`Cannot edit non-existent page: ${path}`, 'NOT_FOUND')
    }
    const firstIdx = existing.body.indexOf(find)
    if (firstIdx === -1) {
      throw new StorageError(
        `Edit find-string not present in ${path}`,
        'PRECONDITION',
      )
    }
    const secondIdx = existing.body.indexOf(find, firstIdx + find.length)
    if (secondIdx !== -1) {
      throw new StorageError(
        `Edit find-string is not unique in ${path}; matched at positions ${firstIdx} and ${secondIdx}`,
        'PRECONDITION',
      )
    }
    const newBody =
      existing.body.slice(0, firstIdx) + replace + existing.body.slice(firstIdx + find.length)
    return this.persist(path, serializeFrontmatter(existing.frontmatter, newBody))
  }

  async search(query: string, opts: WikiSearchOpts = {}): Promise<WikiSearchHit[]> {
    await this.ready
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT
    const offset = opts.offset ?? 0
    const ftsQuery = sanitiseFtsQuery(query)
    if (!ftsQuery) return []
    if (opts.prefix) {
      const like = `${opts.prefix.replace(/[%_]/g, '')}%`
      return this.searchFtsByPrefix.all(ftsQuery, like, limit, offset) as WikiSearchHit[]
    }
    return this.searchFts.all(ftsQuery, limit, offset) as WikiSearchHit[]
  }

  async backlinks(path: string): Promise<WikiSearchHit[]> {
    await this.ready
    const canonical = canonicalisePath(path)
    const row = this.selectByPath.get(canonical) as { name: string | null } | undefined
    // The query takes two parameters; if there's no separate name, bind the
    // path twice — IN deduplicates and the prepared shape stays fixed.
    const secondTarget = row?.name && row.name !== canonical ? row.name : canonical
    const rows = this.selectBacklinksMulti.all(canonical, secondTarget) as Array<{
      path: string
      name: string | null
      snippet: string
    }>
    return rows.map((r) => ({
      path: r.path,
      name: r.name ?? deriveName(r.path),
      snippet: r.snippet,
    }))
  }

  /** Scan the storage tree and rebuild the index from scratch atomically. */
  async reindex(): Promise<void> {
    const work = (async (): Promise<void> => {
      const entries: string[] = []
      for await (const entry of this.cfg.storage.list(this.prefix)) {
        if (entry.path.endsWith('.md')) entries.push(entry.path)
      }

      const indexed: IndexedPage[] = []
      for (let i = 0; i < entries.length; i += REINDEX_READ_CONCURRENCY) {
        const batch = entries.slice(i, i + REINDEX_READ_CONCURRENCY)
        const results = await Promise.all(
          batch.map(async (storagePath) => {
            const result = await this.cfg.storage.read(storagePath)
            const text = result.content.toString('utf-8')
            const parsed = parseFrontmatter(text)
            const canonical = canonicalisePath(this.fromStoragePath(storagePath))
            const name = readName(parsed.frontmatter) ?? deriveName(canonical)
            return {
              canonical,
              name,
              body: parsed.body,
              frontmatter: parsed.frontmatter,
              size: result.size,
              mtime: result.mtime,
              links: extractLinks(parsed.body),
            }
          }),
        )
        indexed.push(...results)
      }

      const nameToPath = new Map<string, string>()
      for (const p of indexed) nameToPath.set(p.name, p.canonical)

      const writeTx = this.cfg.db.transaction(() => {
        this.cfg.db.exec(
          'DELETE FROM wiki_pages; DELETE FROM wiki_pages_fts; DELETE FROM wiki_links',
        )
        for (const p of indexed) {
          this.upsertPage.run({
            path: p.canonical,
            name: p.name,
            body: p.body,
            frontmatter_json: JSON.stringify(p.frontmatter),
            size: p.size,
            updated_at: p.mtime.getTime(),
          })
          this.insertFts.run(p.canonical, p.name, p.body)
          for (const link of p.links) {
            const resolved = this.resolveLink(link, nameToPath)
            if (!resolved) continue
            this.insertLink.run(p.canonical, resolved.to, resolved.kind, link.text)
          }
        }
      })
      writeTx()
    })()

    // Replace `ready` so any concurrent reader awaits the in-flight reindex
    // (not just the initial one). Errors surface to callers via the awaited
    // promise.
    this.ready = work
    return work
  }

  private async persist(path: string, content: string): Promise<WikiPage> {
    const canonical = canonicalisePath(path)
    const storagePath = this.toStoragePath(canonical)
    const stat = await this.cfg.storage.write(storagePath, content)
    const parsed = parseFrontmatter(content)
    const name = readName(parsed.frontmatter) ?? deriveName(canonical)

    const links = extractLinks(parsed.body)
    const selfNames = new Map<string, string>([[name, canonical]])

    const tx = this.cfg.db.transaction(() => {
      this.upsertPage.run({
        path: canonical,
        name,
        body: parsed.body,
        frontmatter_json: JSON.stringify(parsed.frontmatter),
        size: stat.size,
        updated_at: stat.mtime.getTime(),
      })
      this.deleteFtsForPath.run(canonical)
      this.insertFts.run(canonical, name, parsed.body)
      this.deleteLinksFrom.run(canonical)
      for (const link of links) {
        const resolved = this.resolveLink(link, selfNames)
        if (!resolved) continue
        this.insertLink.run(canonical, resolved.to, resolved.kind, link.text)
      }
    })
    tx()

    return {
      path: canonical,
      name,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      raw: parsed.raw,
      updatedAt: stat.mtime,
    }
  }

  /**
   * Resolve a `[[link]]` to a stored target. Order of preference:
   *  1. The supplied `nameMap` (lets the caller pass an in-flight reindex
   *     name index, avoiding DB lookups while the index is empty mid-rebuild).
   *  2. `wiki_pages.name` lookup
   *  3. Literal path
   * `[[file:...]]` links are not recorded as wiki edges; they're document
   * references that the documents skill handles in M6+.
   */
  private resolveLink(
    link: ParsedLink,
    nameMap: Map<string, string>,
  ): { to: string; kind: 'name' | 'path' } | null {
    if (link.kind === 'file') return null
    if (link.kind === 'path') return { to: link.target, kind: 'path' }
    const fromMap = nameMap.get(link.target)
    if (fromMap) return { to: fromMap, kind: 'name' }
    const row = this.selectByName.get(link.target) as { path: string } | undefined
    if (row) return { to: row.path, kind: 'name' }
    return null
  }

  private toStoragePath(canonical: string): string {
    return `${this.prefix}/${canonical}.md`
  }

  private fromStoragePath(storagePath: string): string {
    return storagePath.startsWith(`${this.prefix}/`)
      ? storagePath.slice(this.prefix.length + 1)
      : storagePath
  }
}

function readName(frontmatter: Record<string, unknown>): string | null {
  const v = frontmatter.name
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

function deriveName(canonical: string): string {
  const tail = canonical.split('/').pop() ?? canonical
  return tail
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * FTS5 accepts column filters, prefix matches, NEAR, etc. — but it throws on
 * unbalanced quotes and bare special chars. Quote any non-empty query as a
 * phrase to keep arbitrary input safe; advanced operators get added when the
 * agent learns them.
 */
function sanitiseFtsQuery(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  return `"${trimmed.replace(/"/g, '""')}"`
}

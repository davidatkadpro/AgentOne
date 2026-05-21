import type { Db, PositionalStmt } from '../../storage/db.js'
import type { StorageAdapter, StorageListEntry } from '../../storage/adapter.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS doc_index_v1 (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  text TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_index_fts USING fts5(
  path UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);
`

export function applyDocIndexSchema(db: Db): void {
  db.exec(SCHEMA)
}

export interface DocSearchHit {
  path: string
  snippet: string
  /** Negative score (FTS5 rank). Smaller = better, like other search hits in this codebase. */
  score: number
}

export interface DocSearchOpts {
  limit?: number
  offset?: number
}

export interface DocIndexConfig {
  storage: StorageAdapter
  db: Db
  /** Prefix to scan under — e.g. "projects". */
  prefix?: string
  /**
   * Extracts text from a file's bytes. The indexer calls this lazily for
   * each file whose mtime is newer than the stored row. Defaults to a
   * `null` extractor (every file gets indexed as empty) so consumers can
   * provide a real extraction strategy from the documents skill.
   */
  extract?: (path: string, content: Buffer) => Promise<string | null>
  /** Override Date.now for tests. */
  now?: () => number
}

const DEFAULT_PREFIX = 'projects'
const DEFAULT_LIMIT = 10

/**
 * Lazy-indexed FTS5 search over a prefix of the storage tree (default
 * `projects/`). The agent's documents are stakeholder-authored binaries
 * (PDF, DOCX, XLSX) — extraction is expensive, so we cache extracted text
 * keyed on path + mtime and only re-extract when files change.
 *
 * `ensureFresh()` is the workhorse: lists files in the prefix, diffs
 * against the index, and re-extracts only what's new or stale. Called
 * automatically before each search.
 */
export class DocumentIndex {
  private readonly prefix: string
  private readonly now: () => number

  private readonly selectRow: PositionalStmt
  private readonly upsertRow: PositionalStmt
  private readonly deleteRow: PositionalStmt
  private readonly deleteFts: PositionalStmt
  private readonly insertFts: PositionalStmt
  private readonly searchFts: PositionalStmt

  constructor(private readonly cfg: DocIndexConfig) {
    this.prefix = cfg.prefix ?? DEFAULT_PREFIX
    this.now = cfg.now ?? (() => Date.now())
    applyDocIndexSchema(cfg.db)
    this.selectRow = cfg.db.prepare<unknown[]>(
      'SELECT mtime, bytes FROM doc_index_v1 WHERE path = ?',
    )
    this.upsertRow = cfg.db.prepare<unknown[]>(`
      INSERT INTO doc_index_v1 (path, mtime, bytes, text, indexed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        mtime = excluded.mtime,
        bytes = excluded.bytes,
        text = excluded.text,
        indexed_at = excluded.indexed_at
    `)
    this.deleteRow = cfg.db.prepare<unknown[]>('DELETE FROM doc_index_v1 WHERE path = ?')
    this.deleteFts = cfg.db.prepare<unknown[]>('DELETE FROM doc_index_fts WHERE path = ?')
    this.insertFts = cfg.db.prepare<unknown[]>(
      'INSERT INTO doc_index_fts (path, text) VALUES (?, ?)',
    )
    this.searchFts = cfg.db.prepare<unknown[]>(`
      SELECT path, snippet(doc_index_fts, 1, '', '', '…', 16) AS snippet, rank
      FROM doc_index_fts
      WHERE doc_index_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `)
  }

  /**
   * Scan the storage prefix, re-extract any file whose mtime has changed
   * (or that's missing from the index), and prune entries for files that
   * have been deleted. Returns counts so callers can log progress.
   */
  async ensureFresh(): Promise<{ added: number; updated: number; deleted: number }> {
    const seen = new Set<string>()
    const entries: StorageListEntry[] = []
    for await (const entry of this.cfg.storage.list(this.prefix)) {
      entries.push(entry)
      seen.add(entry.path)
    }

    let added = 0
    let updated = 0

    for (const entry of entries) {
      const existing = this.selectRow.get(entry.path) as
        | { mtime: number; bytes: number }
        | undefined
      const newMtime = entry.mtime.getTime()
      if (existing && existing.mtime === newMtime && existing.bytes === entry.size) {
        continue
      }
      let text: string | null = ''
      try {
        const result = await this.cfg.storage.read(entry.path)
        text = this.cfg.extract
          ? await this.cfg.extract(entry.path, result.content)
          : null
      } catch {
        // Read failure: skip this file rather than blowing up the whole pass.
        continue
      }
      if (text === null) continue
      this.upsertRow.run(entry.path, newMtime, entry.size, text, this.now())
      this.deleteFts.run(entry.path)
      this.insertFts.run(entry.path, text)
      if (existing) updated++
      else added++
    }

    // Prune rows for files that disappeared.
    const indexed = this.cfg.db
      .prepare<unknown[]>('SELECT path FROM doc_index_v1')
      .all() as Array<{ path: string }>
    let deleted = 0
    for (const row of indexed) {
      if (!seen.has(row.path)) {
        this.deleteRow.run(row.path)
        this.deleteFts.run(row.path)
        deleted++
      }
    }

    return { added, updated, deleted }
  }

  /**
   * FTS5 search across indexed document text. Auto-calls ensureFresh()
   * before each search — for production with many docs this should be
   * gated behind a mtime-cache TTL, but for the v1 workload (a dozen
   * docs) the cost is acceptable.
   */
  async search(query: string, opts: DocSearchOpts = {}): Promise<DocSearchHit[]> {
    await this.ensureFresh()
    const trimmed = query.trim()
    if (!trimmed) return []
    const limit = opts.limit ?? DEFAULT_LIMIT
    const offset = opts.offset ?? 0
    const rows = this.searchFts.all(trimmed, limit, offset) as Array<{
      path: string
      snippet: string
      rank: number
    }>
    return rows.map((r) => ({ path: r.path, snippet: r.snippet, score: r.rank }))
  }
}

import type { Db } from '../../storage/db.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wiki_pages (
  path TEXT PRIMARY KEY,
  name TEXT,
  body TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_name ON wiki_pages(name) WHERE name IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
  path UNINDEXED,
  name,
  body,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS wiki_links (
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('name', 'path', 'file')),
  link_text TEXT NOT NULL,
  PRIMARY KEY (from_path, to_path, link_text)
);

CREATE INDEX IF NOT EXISTS idx_wiki_links_to ON wiki_links(to_path);
CREATE INDEX IF NOT EXISTS idx_wiki_links_from ON wiki_links(from_path);
`

export function applyWikiSchema(db: Db): void {
  db.exec(SCHEMA)
}

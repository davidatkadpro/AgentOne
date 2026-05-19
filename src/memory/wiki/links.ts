/**
 * Three link forms are recognized inside `[[...]]`:
 *
 *  - `[[Name]]`                    → name lookup (resolves via the wiki's name index)
 *  - `[[path/to/page]]`            → direct path reference (with or without `.md`)
 *  - `[[file:projects/scope.pdf]]` → external Document reference (no resolution)
 *
 * Link text is whatever is inside the brackets, trimmed.
 */
export interface ParsedLink {
  raw: string
  text: string
  kind: 'name' | 'path' | 'file'
  target: string
}

const LINK_RE = /\[\[([^\[\]]+)\]\]/g

export function extractLinks(content: string): ParsedLink[] {
  const out: ParsedLink[] = []
  for (const match of content.matchAll(LINK_RE)) {
    const text = (match[1] ?? '').trim()
    if (!text) continue
    out.push(classify(match[0], text))
  }
  return out
}

function classify(raw: string, text: string): ParsedLink {
  if (text.startsWith('file:')) {
    return { raw, text, kind: 'file', target: text.slice('file:'.length).trim() }
  }
  if (text.includes('/') || text.endsWith('.md')) {
    return { raw, text, kind: 'path', target: canonicalisePath(text) }
  }
  return { raw, text, kind: 'name', target: text }
}

/** Strip a trailing ".md" and normalise slashes; leave the rest verbatim. */
export function canonicalisePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\.md$/i, '')
}

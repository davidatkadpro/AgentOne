import yaml from 'js-yaml'

export interface ParsedDocument {
  frontmatter: Record<string, unknown>
  body: string
  raw: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseFrontmatter(content: string): ParsedDocument {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return { frontmatter: {}, body: content, raw: content }
  let frontmatter: Record<string, unknown> = {}
  try {
    const loaded = yaml.load(match[1] ?? '')
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      frontmatter = loaded as Record<string, unknown>
    }
  } catch {
    // Malformed frontmatter — treat whole input as body so writes still survive.
    return { frontmatter: {}, body: content, raw: content }
  }
  // Strip leading whitespace that sits between the closing `---` and the body.
  // The serializer always emits `---\n\n<body>`, so the captured group includes
  // one extra newline; without trimming, append() would produce body
  // `\n\nexisting\n\naddition` instead of `existing\n\naddition`.
  const body = (match[2] ?? '').replace(/^\r?\n+/, '')
  return { frontmatter, body, raw: content }
}

export function serializeFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  if (Object.keys(frontmatter).length === 0) return body
  const yamlText = yaml.dump(frontmatter, { lineWidth: 100 }).trimEnd()
  return `---\n${yamlText}\n---\n\n${body}`
}

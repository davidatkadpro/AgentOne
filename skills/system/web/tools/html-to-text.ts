/**
 * HTML-to-readable-text converter for LLM consumption.
 *
 * Ported from LocalAgent's html_parser.py: strips scripts/styles/nav chrome,
 * preserves structure via markdown-style headings, list markers, and link
 * URLs, and prefers content inside <main>/<article> when present.
 *
 * Uses a tiny hand-rolled HTML tokenizer (no external deps) — sufficient
 * for "feed an LLM" extraction quality, not a general-purpose HTML parser.
 */

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'option',
  'textarea',
])

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'table',
  'tr',
  'dl',
  'dt',
  'dd',
  'ul',
  'ol',
])

const HEADING_TAGS: Record<string, string> = {
  h1: '#',
  h2: '##',
  h3: '###',
  h4: '####',
  h5: '#####',
  h6: '######',
}

const CONTENT_AREAS = new Set(['main', 'article'])

// Sentinels survive whitespace cleanup so <pre> contents stay verbatim.
const PRE_OPEN = '\x00PRE_OPEN\x00'
const PRE_CLOSE = '\x00PRE_CLOSE\x00'

const RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'textarea', 'title'])

interface StartTag {
  kind: 'start'
  tag: string
  attrs: Record<string, string>
  selfClosing: boolean
}
interface EndTag {
  kind: 'end'
  tag: string
}
interface TextNode {
  kind: 'text'
  data: string
}
type Token = StartTag | EndTag | TextNode

export function htmlToReadableText(html: string): string {
  const tokens = tokenize(html)
  const out: string[] = []
  let skipDepth = 0
  let inPre = false
  let linkHref: string | null = null
  let linkText = ''
  let contentStart: number | null = null
  let contentEnd: number | null = null
  let contentDepth = 0

  for (const t of tokens) {
    if (t.kind === 'start') {
      if (SKIP_TAGS.has(t.tag)) {
        skipDepth++
        continue
      }
      if (skipDepth > 0) continue

      if (CONTENT_AREAS.has(t.tag)) {
        if (contentStart === null) contentStart = out.length
        contentDepth++
      }
      if (BLOCK_TAGS.has(t.tag)) out.push('\n\n')
      if (HEADING_TAGS[t.tag]) out.push(`${HEADING_TAGS[t.tag]} `)
      if (t.tag === 'li') out.push('\n- ')
      if (t.tag === 'br') out.push('\n')
      if (t.tag === 'a') {
        const href = t.attrs.href ?? ''
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          linkHref = href
          linkText = ''
        }
      }
      if (t.tag === 'pre') {
        inPre = true
        out.push(PRE_OPEN)
      }
      if (t.tag === 'blockquote') out.push('> ')
      if (t.tag === 'td' || t.tag === 'th') out.push(' | ')
    } else if (t.kind === 'end') {
      if (SKIP_TAGS.has(t.tag)) {
        skipDepth = Math.max(0, skipDepth - 1)
        continue
      }
      if (skipDepth > 0) continue

      if (CONTENT_AREAS.has(t.tag) && contentDepth > 0) {
        contentDepth--
        if (contentDepth === 0) contentEnd = out.length
      }
      if (BLOCK_TAGS.has(t.tag)) out.push('\n')
      if (t.tag === 'pre') {
        inPre = false
        out.push(PRE_CLOSE)
      }
      if (t.tag === 'a' && linkHref !== null) {
        const text = linkText.trim()
        const href = linkHref
        if (text && href !== text && !text.startsWith('http')) {
          out.push(` [${href}]`)
        }
        linkHref = null
        linkText = ''
      }
    } else {
      if (skipDepth > 0) continue
      const data = decodeEntities(t.data)
      if (linkHref !== null) linkText += data
      if (inPre) {
        out.push(data)
      } else {
        const collapsed = data.replace(/\s+/g, ' ')
        if (collapsed.trim()) out.push(collapsed)
      }
    }
  }

  if (
    contentStart !== null &&
    contentEnd !== null &&
    contentEnd > contentStart
  ) {
    const slice = out.slice(contentStart, contentEnd).join('')
    if (slice.trim().length > 100) return clean(slice)
  }
  return clean(out.join(''))
}

function clean(text: string): string {
  const collapsed = text.replace(/\n{3,}/g, '\n\n')
  const parts = collapsed.split(/\x00PRE_(?:OPEN|CLOSE)\x00/)
  const cleaned: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      cleaned.push(
        parts[i]!
          .split('\n')
          .map((line) => line.trim())
          .join('\n'),
      )
    } else {
      cleaned.push(parts[i]!)
    }
  }
  return cleaned.join('').replace(/^\n+|\n+$/g, '')
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  const n = html.length
  let i = 0

  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      pushText(tokens, html.slice(i))
      break
    }
    if (lt > i) pushText(tokens, html.slice(i, lt))

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9)
      if (end !== -1) pushText(tokens, html.slice(lt + 9, end))
      i = end === -1 ? n : end + 3
      continue
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 2)
      i = end === -1 ? n : end + 1
      continue
    }
    if (html[lt + 1] === '/') {
      const end = html.indexOf('>', lt + 2)
      if (end === -1) {
        i = n
        break
      }
      const name = html
        .slice(lt + 2, end)
        .trim()
        .split(/\s+/)[0]!
        .toLowerCase()
      tokens.push({ kind: 'end', tag: name })
      i = end + 1
      continue
    }

    const end = findTagEnd(html, lt + 1)
    if (end === -1) {
      i = n
      break
    }
    const parsed = parseStartTag(html.slice(lt + 1, end))
    if (!parsed.tag) {
      i = end + 1
      continue
    }
    tokens.push(parsed)
    i = end + 1

    if (RAW_TEXT_TAGS.has(parsed.tag) && !parsed.selfClosing) {
      const closer = new RegExp(`</\\s*${parsed.tag}\\s*>`, 'i')
      const m = closer.exec(html.slice(i))
      if (m) {
        pushText(tokens, html.slice(i, i + m.index))
        i += m.index + m[0].length
        tokens.push({ kind: 'end', tag: parsed.tag })
      } else {
        i = n
      }
    }
  }
  return tokens
}

function pushText(tokens: Token[], data: string): void {
  if (data) tokens.push({ kind: 'text', data })
}

function findTagEnd(html: string, start: number): number {
  let i = start
  let quote: '"' | "'" | null = null
  while (i < html.length) {
    const c = html[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c as '"' | "'"
    } else if (c === '>') {
      return i
    }
    i++
  }
  return -1
}

const ATTR_RE =
  /\s+([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function parseStartTag(inner: string): StartTag {
  let body = inner
  let selfClosing = false
  if (body.endsWith('/')) {
    selfClosing = true
    body = body.slice(0, -1)
  }
  const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body)
  if (!nameMatch) return { kind: 'start', tag: '', attrs: {}, selfClosing }
  const tag = nameMatch[1]!.toLowerCase()
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = nameMatch[0].length
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(body)) !== null) {
    const name = m[1]!.toLowerCase()
    const value = m[2] ?? m[3] ?? m[4] ?? ''
    attrs[name] = decodeEntities(value)
  }
  return { kind: 'start', tag, attrs, selfClosing }
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (full, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = parseInt(name.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    if (name.startsWith('#')) {
      const code = parseInt(name.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    return ENTITY_MAP[name.toLowerCase()] ?? full
  })
}

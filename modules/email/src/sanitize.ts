/**
 * Email-body HTML sanitiser. Single-purpose, no external deps.
 *
 * Threat model — single-user local app, but incoming emails are untrusted
 * input. We strip anything that can execute script or exfil data: <script>,
 * <iframe>, <object>, <embed>, <link>, <meta>, <form>, <base>, <style>, every
 * on*= attribute, javascript: / data: URLs, and inline `style=` attributes.
 *
 * What we keep: standard prose (p, div, span, h1-h6, ul, ol, li, blockquote,
 * pre, code, table, tr, td, th, br, hr), inline formatting (b, i, em, strong,
 * u, s, sup, sub, mark), <a href> with http(s)/mailto, and <img src> with
 * https only. CID images stay broken (no inline image rendering in v2).
 *
 * The parser is a small forward state machine over the input string. It is
 * deliberately strict about what looks like a tag — when in doubt the
 * tokeniser drops the bytes. This is safer than trying to repair malformed
 * input.
 *
 * The sanitiser is the PRIMARY defence per the v2 spec. The frontend layers
 * DOMPurify on top as defence-in-depth.
 */

const DANGEROUS_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'form',
  'base',
  'style',
  'svg',
  'math',
])

const ALLOWED_TAGS = new Set([
  // structure
  'html',
  'body',
  'div',
  'span',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'main',
  'aside',
  // text
  'p',
  'br',
  'hr',
  'blockquote',
  'pre',
  'code',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  // inline
  'a',
  'img',
  'b',
  'i',
  'u',
  's',
  'em',
  'strong',
  'small',
  'sup',
  'sub',
  'mark',
  'q',
  'cite',
  'abbr',
  // lists
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  // tables
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'col',
  'colgroup',
])

const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'align']),
  th: new Set(['colspan', 'rowspan', 'align']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span', 'width']),
  table: new Set(['border', 'cellpadding', 'cellspacing']),
}

/** Tags that have no closing form in HTML5 (we don't write their close). */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'wbr'])

const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])

export interface SanitizeOptions {
  /** When false (default), restrict <img src=…> to https URLs only. When true,
   *  allow http too. Even with allowHttpImages=true, javascript:/data:/file:
   *  URLs are still rejected. */
  allowHttpImages?: boolean
}

export function sanitizeEmailHtml(input: string, opts: SanitizeOptions = {}): string {
  const out: string[] = []
  const stack: string[] = []
  let i = 0
  const len = input.length

  while (i < len) {
    const ch = input[i]
    if (ch === '<') {
      // Comment / CDATA / declaration / processing instruction — drop entirely.
      if (input.startsWith('<!--', i)) {
        const end = input.indexOf('-->', i + 4)
        if (end === -1) break
        i = end + 3
        continue
      }
      if (input.startsWith('<![CDATA[', i)) {
        const end = input.indexOf(']]>', i + 9)
        if (end === -1) break
        i = end + 3
        continue
      }
      if (input[i + 1] === '!' || input[i + 1] === '?') {
        const end = input.indexOf('>', i)
        if (end === -1) break
        i = end + 1
        continue
      }
      // Close tag.
      if (input[i + 1] === '/') {
        const end = input.indexOf('>', i)
        if (end === -1) break
        const name = input.slice(i + 2, end).trim().toLowerCase()
        if (ALLOWED_TAGS.has(name)) {
          const last = stack.lastIndexOf(name)
          if (last !== -1) {
            // Pop everything up to and including `name`. We close them all
            // in reverse to keep the output well-formed even when senders
            // emit overlapping ranges.
            for (let k = stack.length - 1; k >= last; k--) {
              const t = stack[k]!
              if (!VOID_TAGS.has(t)) out.push(`</${t}>`)
            }
            stack.length = last
          }
        }
        i = end + 1
        continue
      }
      // Open tag.
      const tagEnd = findTagEnd(input, i)
      if (tagEnd === -1) {
        // Malformed — drop the rest.
        break
      }
      const inside = input.slice(i + 1, tagEnd)
      const selfClose = inside.endsWith('/')
      const body = selfClose ? inside.slice(0, -1) : inside
      const { name, attrs } = parseTag(body)
      const tag = name.toLowerCase()

      if (DANGEROUS_TAGS.has(tag)) {
        // Skip the entire element including its contents.
        i = skipDangerousElement(input, i, tag, tagEnd)
        continue
      }
      if (!ALLOWED_TAGS.has(tag)) {
        // Unknown tag — drop the tag but keep nested content (defensive).
        i = tagEnd + 1
        continue
      }

      const cleanedAttrs = filterAttrs(tag, attrs, opts)
      const attrStr =
        cleanedAttrs.length > 0
          ? ' ' + cleanedAttrs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(' ')
          : ''

      if (VOID_TAGS.has(tag) || selfClose) {
        out.push(`<${tag}${attrStr}>`)
      } else {
        out.push(`<${tag}${attrStr}>`)
        stack.push(tag)
      }
      i = tagEnd + 1
      continue
    }

    // Text content. Copy verbatim until next `<`. We don't entity-decode here
    // — the input's entities pass through unchanged, which is safe.
    const next = input.indexOf('<', i)
    if (next === -1) {
      out.push(input.slice(i))
      break
    }
    out.push(input.slice(i, next))
    i = next
  }

  // Close anything still open so the output is well-formed.
  for (let k = stack.length - 1; k >= 0; k--) {
    const t = stack[k]!
    if (!VOID_TAGS.has(t)) out.push(`</${t}>`)
  }

  return out.join('')
}

// ── helpers ────────────────────────────────────────────────────────────────

function findTagEnd(input: string, start: number): number {
  // Walk forward, ignoring `>` characters inside attribute values. Simple
  // double/single quote tracking is enough for sanitiser purposes; we don't
  // need to handle escaped quotes (HTML doesn't have them inside attrs).
  let quote: string | null = null
  for (let i = start + 1; i < input.length; i++) {
    const c = input[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '>') return i
  }
  return -1
}

function skipDangerousElement(
  input: string,
  _startLt: number,
  tag: string,
  openTagEnd: number,
): number {
  // For void-like dangerous tags (<meta>, <link>, <base>) there is no end tag
  // — just skip the open. For the rest, scan to the matching </tag> and skip
  // everything in between.
  if (tag === 'meta' || tag === 'link' || tag === 'base') {
    return openTagEnd + 1
  }
  const close = new RegExp(`</\\s*${tag}\\s*>`, 'i')
  const m = close.exec(input.slice(openTagEnd))
  if (!m) {
    // No closing tag — drop to end of input.
    return input.length
  }
  return openTagEnd + m.index + m[0].length
}

interface ParsedTag {
  name: string
  attrs: Array<[string, string]>
}

function parseTag(body: string): ParsedTag {
  body = body.trim()
  // Tag name is leading [A-Za-z][A-Za-z0-9-]*; everything after the first
  // whitespace is attribute soup.
  const m = /^([A-Za-z][A-Za-z0-9-]*)\s*(.*)$/s.exec(body)
  if (!m) return { name: '', attrs: [] }
  const name = m[1]!
  const rest = m[2] ?? ''
  const attrs: Array<[string, string]> = []
  const attrRe =
    /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let am: RegExpExecArray | null
  while ((am = attrRe.exec(rest)) !== null) {
    const attrName = am[1]!
    const v = am[3] ?? am[4] ?? am[5] ?? ''
    attrs.push([attrName, v])
  }
  return { name, attrs }
}

function filterAttrs(
  tag: string,
  attrs: Array<[string, string]>,
  opts: SanitizeOptions,
): Array<[string, string]> {
  const allowed = ALLOWED_ATTRS[tag]
  const out: Array<[string, string]> = []
  for (const [k, v] of attrs) {
    const lk = k.toLowerCase()
    // Block every event handler and the legacy IE expression hooks.
    if (lk.startsWith('on') || lk === 'srcdoc' || lk === 'style' || lk === 'formaction') {
      continue
    }
    if (!allowed || !allowed.has(lk)) continue
    // URL attributes get URL-scheme filtering.
    if (lk === 'href') {
      if (!isSafeUrl(v)) continue
    } else if (lk === 'src') {
      if (!isSafeImageUrl(v, opts)) continue
    }
    out.push([lk, v])
  }
  return out
}

function isSafeUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return false
  // Relative URLs (#, /, ./, ../) are technically safe but never useful in
  // the email body context — drop them so the link is inert.
  if (trimmed.startsWith('#')) return true
  try {
    const u = new URL(trimmed)
    return SAFE_URL_SCHEMES.has(u.protocol)
  } catch {
    return false
  }
}

function isSafeImageUrl(raw: string, opts: SanitizeOptions): boolean {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return false
  if (trimmed.toLowerCase().startsWith('cid:')) return false
  try {
    const u = new URL(trimmed)
    if (u.protocol === 'https:') return true
    if (u.protocol === 'http:' && opts.allowHttpImages) return true
    return false
  } catch {
    return false
  }
}

function escapeAttr(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

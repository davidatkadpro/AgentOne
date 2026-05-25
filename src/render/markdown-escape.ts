/**
 * Escape user-controlled strings before interpolating them into rendered
 * Markdown that will be passed through Pandoc to PDF/DOCX.
 *
 * Two surfaces matter:
 *
 *   1. **Table cells** — pipes (`|`) break GFM tables; newlines collapse
 *      multi-row cells; backslashes need to survive a Pandoc round-trip.
 *
 *   2. **Block content (notes, descriptions)** — raw HTML and LaTeX can
 *      survive Pandoc and influence the output document. We don't fully
 *      sanitise (this is local-trust), but we strip the constructs most
 *      likely to leak.
 *
 * The caller is also expected to set Pandoc's input format to a variant
 * that disables raw HTML/LaTeX (e.g. `markdown_strict` or `gfm-raw_html`).
 * Both layers together = defence in depth.
 */

/** Escape a string for safe placement inside a GFM table cell. */
export function escapeTableCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'string' ? value : String(value)
  return s
    .replace(/\\/g, '\\\\') // escape backslashes first so other escapes survive
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ') // table cells can't contain real newlines
}

/**
 * Escape a string for safe placement inside Markdown block content (a
 * paragraph, a notes block). Newlines preserved; we just neutralise the
 * leading-character constructs that change semantics (headings, lists,
 * blockquotes) and strip obvious raw HTML / LaTeX directives.
 */
export function escapeBlock(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  // Strip raw <script>/<style> and inline events — neutralise rather than
  // attempt full sanitisation. Pandoc with raw_html disabled will treat
  // remaining tags as literal text.
  let s = value.replace(/<\s*(script|style|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  // Strip LaTeX-y directives that pandoc accepts even in markdown:
  // \input{}, \include{}, \write18{}, etc. (only the well-known dangerous
  // ones; user-typed `\command` text otherwise passes through as literal).
  s = s.replace(/\\(?:input|include|write18|immediate|openout|openin)\b[^\n]*/gi, '')
  // Escape leading-of-line characters that start block constructs.
  return s
    .split('\n')
    .map((line) => line.replace(/^(\s*)([#>\-*+|])/, '$1\\$2'))
    .join('\n')
}

/**
 * Argument set we hand to Pandoc on the input side to disable raw HTML +
 * LaTeX where the format allows it. Callers append these to their
 * `extraArgs`.
 */
export function pandocSafeInputArgs(format: 'markdown' | 'gfm'): string[] {
  // Pandoc syntax: `-f gfm-raw_html` disables the raw HTML extension.
  // For plain markdown we drop raw_html and raw_tex.
  if (format === 'gfm') return ['-f', 'gfm-raw_html']
  return ['-f', 'markdown-raw_html-raw_tex']
}

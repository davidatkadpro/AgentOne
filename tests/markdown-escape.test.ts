import { describe, expect, it } from 'vitest'
import {
  escapeBlock,
  escapeTableCell,
  pandocSafeInputArgs,
} from '../src/render/markdown-escape.js'

describe('escapeTableCell', () => {
  it('escapes pipes so they do not split a GFM row', () => {
    expect(escapeTableCell('a | b')).toBe('a \\| b')
    expect(escapeTableCell('|||')).toBe('\\|\\|\\|')
  })

  it('replaces newlines with spaces (table cells cannot wrap)', () => {
    expect(escapeTableCell('a\nb')).toBe('a b')
    expect(escapeTableCell('a\r\nb')).toBe('a b')
  })

  it('escapes backslashes before other escapes', () => {
    // A literal backslash should survive Pandoc as `\\`.
    expect(escapeTableCell('a\\b')).toBe('a\\\\b')
  })

  it('returns empty string for null/undefined', () => {
    expect(escapeTableCell(null)).toBe('')
    expect(escapeTableCell(undefined)).toBe('')
  })

  it('passes numeric values through as strings', () => {
    expect(escapeTableCell(42)).toBe('42')
    expect(escapeTableCell(0.5)).toBe('0.5')
  })
})

describe('escapeBlock', () => {
  it('strips <script> tags', () => {
    const out = escapeBlock('hi <script>alert(1)</script> bye')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert')
  })

  it('strips <iframe>/<object>/<embed>/<style>', () => {
    for (const tag of ['iframe', 'object', 'embed', 'style']) {
      const out = escapeBlock(`a<${tag}>x</${tag}>b`)
      expect(out).toBe('ab')
    }
  })

  it('strips LaTeX directives commonly used to escape pandoc', () => {
    // The directive AND the rest of its line are removed — we can't tell
    // where the brace closes safely, so we drop the line tail.
    expect(escapeBlock('hello \\input{/etc/passwd} world')).toBe('hello ')
    expect(escapeBlock('\\write18{rm -rf /}')).toBe('')
    // Non-dangerous backslash commands survive (they'll be literal in
    // Pandoc output once raw_tex is disabled at the input layer).
    expect(escapeBlock('safe \\command{x} stays')).toContain('\\command')
  })

  it('escapes leading-of-line markdown constructs', () => {
    expect(escapeBlock('# Heading')).toBe('\\# Heading')
    expect(escapeBlock('> blockquote')).toBe('\\> blockquote')
    expect(escapeBlock('- list')).toBe('\\- list')
    expect(escapeBlock('| pipe-line start')).toBe('\\| pipe-line start')
  })

  it('preserves middle-of-line characters that would otherwise be markdown', () => {
    expect(escapeBlock('cost is $5 - $10')).toContain('$5 - $10')
  })

  it('processes each line independently', () => {
    const out = escapeBlock('safe\n# heading\nsafe')
    expect(out).toBe('safe\n\\# heading\nsafe')
  })
})

describe('pandocSafeInputArgs', () => {
  it('disables raw_html for gfm', () => {
    expect(pandocSafeInputArgs('gfm')).toEqual(['-f', 'gfm-raw_html'])
  })

  it('disables raw_html + raw_tex for markdown', () => {
    expect(pandocSafeInputArgs('markdown')).toEqual([
      '-f',
      'markdown-raw_html-raw_tex',
    ])
  })
})

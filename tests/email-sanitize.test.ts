import { describe, it, expect } from 'vitest'
import { sanitizeEmailHtml } from '../modules/email/src/sanitize.js'

describe('sanitizeEmailHtml', () => {
  it('strips <script> tags and their contents', () => {
    const out = sanitizeEmailHtml(`<p>hi</p><script>alert('x')</script><p>bye</p>`)
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).toContain('<p>hi</p>')
    expect(out).toContain('<p>bye</p>')
  })

  it('strips <iframe>, <object>, <embed>, <form>, <style>, <meta>, <link>', () => {
    const inputs = [
      `<iframe src="x"></iframe>`,
      `<object data="x"></object>`,
      `<embed src="x">`,
      `<form action="x"><input></form>`,
      `<style>body{display:none}</style>`,
      `<meta http-equiv="refresh" content="0;url=x">`,
      `<link rel="stylesheet" href="x">`,
    ]
    for (const input of inputs) {
      const out = sanitizeEmailHtml(input)
      expect(out).not.toMatch(/<(iframe|object|embed|form|style|meta|link)/i)
    }
  })

  it('removes on* event-handler attributes', () => {
    const out = sanitizeEmailHtml(`<a href="https://example.com" onclick="evil()">x</a>`)
    expect(out).not.toContain('onclick')
    expect(out).toContain('href="https://example.com"')
  })

  it('removes style attributes (CSS-based exfil)', () => {
    const out = sanitizeEmailHtml(`<p style="background:url(x)">hi</p>`)
    expect(out).not.toContain('style')
  })

  it('rejects javascript: URLs in href', () => {
    const out = sanitizeEmailHtml(`<a href="javascript:alert(1)">x</a>`)
    expect(out).not.toContain('javascript:')
    expect(out).toContain('<a>x</a>') // tag survives, attr stripped
  })

  it('rejects data: URLs in href', () => {
    const out = sanitizeEmailHtml(`<a href="data:text/html,<script>1</script>">x</a>`)
    expect(out).not.toContain('data:')
  })

  it('rejects http:// images by default but allows https://', () => {
    const out1 = sanitizeEmailHtml(`<img src="http://insecure/x.png">`)
    expect(out1).not.toContain('src=')
    const out2 = sanitizeEmailHtml(`<img src="https://secure/x.png">`)
    expect(out2).toContain('src="https://secure/x.png"')
  })

  it('drops cid: images', () => {
    const out = sanitizeEmailHtml(`<img src="cid:logo@1">`)
    expect(out).not.toContain('cid:')
  })

  it('keeps standard prose tags + safe attributes', () => {
    const input = `<p>Hello</p><ul><li>one</li><li><b>two</b></li></ul><a href="https://x.com" title="t">link</a>`
    const out = sanitizeEmailHtml(input)
    expect(out).toContain('<p>Hello</p>')
    expect(out).toContain('<ul>')
    expect(out).toContain('<b>two</b>')
    expect(out).toContain('<a href="https://x.com" title="t">link</a>')
  })

  it('closes unclosed tags', () => {
    const out = sanitizeEmailHtml(`<p>hi`)
    expect(out).toBe('<p>hi</p>')
  })

  it('drops unknown tags but keeps their text', () => {
    const out = sanitizeEmailHtml(`<custom-element>text</custom-element>`)
    expect(out).toBe('text')
  })

  it('handles HTML comments without leaking script content', () => {
    const out = sanitizeEmailHtml(`<!-- <script>alert(1)</script> --><p>ok</p>`)
    expect(out).toContain('<p>ok</p>')
    expect(out).not.toContain('script')
  })

  it('respects allowHttpImages opt-in', () => {
    const out = sanitizeEmailHtml(`<img src="http://x.com/i.png">`, { allowHttpImages: true })
    expect(out).toContain('src="http://x.com/i.png"')
  })

  it('does not break on empty input', () => {
    expect(sanitizeEmailHtml('')).toBe('')
  })

  it('does not break on plain-text input (no tags)', () => {
    expect(sanitizeEmailHtml('hello & world')).toBe('hello & world')
  })

  it('strips srcdoc + formaction sneaky attrs', () => {
    const a = sanitizeEmailHtml(`<a href="https://x.com" srcdoc="..." formaction="...">x</a>`)
    expect(a).not.toContain('srcdoc')
    expect(a).not.toContain('formaction')
  })

  it('handles attribute quotes correctly (no premature close)', () => {
    const out = sanitizeEmailHtml(`<a href="https://x.com" title="a > b">x</a>`)
    expect(out).toContain('title="a &gt; b"')
    expect(out).toContain('x</a>')
  })

  it('treats a bare `<` followed by text as literal (no data loss)', () => {
    expect(sanitizeEmailHtml(`a < b`)).toBe('a &lt; b')
    expect(sanitizeEmailHtml(`if x<3 then`)).toBe('if x&lt;3 then')
  })

  it('treats a trailing bare `<` as literal', () => {
    expect(sanitizeEmailHtml(`hello <`)).toBe('hello &lt;')
  })

  it('preserves <p>x &lt; y</p> intact (already-escaped HTML)', () => {
    expect(sanitizeEmailHtml(`<p>x &lt; y</p>`)).toBe('<p>x &lt; y</p>')
  })

  it('case-insensitive tag matching strips <SCRIPT>', () => {
    expect(sanitizeEmailHtml(`<P>ok</P><SCRIPT>alert(1)</SCRIPT>`)).not.toContain('SCRIPT')
    expect(sanitizeEmailHtml(`<P>ok</P><SCRIPT>alert(1)</SCRIPT>`)).not.toContain('script')
    expect(sanitizeEmailHtml(`<P>ok</P>`)).toBe('<p>ok</p>')
  })

  it('rejects javascript: with mixed case', () => {
    const out = sanitizeEmailHtml(`<a href="JavaScript:alert(1)">x</a>`)
    expect(out).not.toMatch(/javascript:/i)
  })

  it('handles nested <script> blocks correctly', () => {
    const out = sanitizeEmailHtml(`<p>safe</p><script>x</script><script>y</script><p>also safe</p>`)
    expect(out).not.toContain('script')
    expect(out).toContain('<p>safe</p>')
    expect(out).toContain('<p>also safe</p>')
  })
})

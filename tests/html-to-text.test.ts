import { describe, it, expect } from 'vitest'
import { htmlToReadableText } from '../skills/system/web/tools/html-to-text.js'

describe('htmlToReadableText', () => {
  it('strips scripts and styles', () => {
    const html =
      '<html><head><style>body{color:red}</style></head>' +
      '<body><script>var x=1</script><p>Hello</p></body></html>'
    expect(htmlToReadableText(html)).toBe('Hello')
  })

  it('converts headings to markdown', () => {
    const out = htmlToReadableText('<h1>Title</h1><p>Body.</p>')
    expect(out).toContain('# Title')
    expect(out).toContain('Body.')
  })

  it('converts list items to dashes', () => {
    const out = htmlToReadableText('<ul><li>one</li><li>two</li></ul>')
    expect(out).toContain('- one')
    expect(out).toContain('- two')
  })

  it('decodes entities', () => {
    expect(htmlToReadableText('<p>A &amp; B &lt; C</p>')).toBe('A & B < C')
  })

  it('preserves link href when link text differs from URL', () => {
    const out = htmlToReadableText(
      '<p>See <a href="https://example.com/docs">the docs</a></p>',
    )
    expect(out).toContain('the docs')
    expect(out).toContain('[https://example.com/docs]')
  })

  it('does not emit [href] when link text already starts with http', () => {
    const out = htmlToReadableText(
      '<a href="https://example.com">https://example.com</a>',
    )
    expect(out).not.toContain('[https://example.com]')
  })

  it('skips comments', () => {
    const out = htmlToReadableText('<p>Hi <!-- secret --> there</p>')
    expect(out).toContain('Hi')
    expect(out).toContain('there')
    expect(out).not.toContain('secret')
  })

  it('preserves whitespace and newlines in <pre> blocks', () => {
    const out = htmlToReadableText('<pre>  line1\n  line2</pre>')
    expect(out).toContain('  line1\n  line2')
  })

  it('prefers <main> content when substantial', () => {
    const mainContent = 'Article body — '.repeat(20)
    const html =
      '<html><body><div>chrome content above</div>' +
      `<main><p>${mainContent}</p></main>` +
      '<div>chrome content below</div></body></html>'
    const out = htmlToReadableText(html)
    expect(out).toContain('Article body')
    expect(out).not.toContain('chrome content above')
    expect(out).not.toContain('chrome content below')
  })

  it('falls back to full document when <main> content is too short', () => {
    const html =
      '<html><body><div>visible chrome</div><main>tiny</main></body></html>'
    const out = htmlToReadableText(html)
    expect(out).toContain('visible chrome')
    expect(out).toContain('tiny')
  })

  it('skips nav/header/footer/aside chrome', () => {
    const html =
      '<body><nav>NAVLINKS</nav><header>HEAD</header>' +
      '<p>main copy</p>' +
      '<aside>SIDE</aside><footer>FOOT</footer></body>'
    const out = htmlToReadableText(html)
    expect(out).toContain('main copy')
    expect(out).not.toMatch(/NAVLINKS|HEAD|SIDE|FOOT/)
  })

  it('handles self-closing void tags like <br>', () => {
    const out = htmlToReadableText('<p>line one<br>line two</p>')
    expect(out).toContain('line one')
    expect(out).toContain('line two')
    expect(out.indexOf('line one')).toBeLessThan(out.indexOf('line two'))
  })
})

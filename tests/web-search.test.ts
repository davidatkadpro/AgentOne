import { describe, it, expect } from 'vitest'
import { parseDuckDuckGoResults } from '../skills/system/web/tools/web-search.js'

const FIXTURE = `
<html><body>
  <div class="result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">
        First &amp; only <b>result</b>
      </a>
    </h2>
    <a class="result__snippet" href="https://example.com/one">
      A snippet describing the <b>first</b> result.
    </a>
  </div>
  <div class="result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://direct.example.org/two">
        Direct link result
      </a>
    </h2>
    <div class="result__snippet">Second snippet.</div>
  </div>
  <div class="result result--ad">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fad.example.com">
        Ad title with &quot;quotes&quot;
      </a>
    </h2>
    <a class="result__snippet">Ad snippet.</a>
  </div>
</body></html>
`

describe('parseDuckDuckGoResults', () => {
  it('extracts title, url, and snippet for each result', () => {
    const results = parseDuckDuckGoResults(FIXTURE)
    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({
      title: 'First & only result',
      url: 'https://example.com/one',
      snippet: 'A snippet describing the first result.',
    })
  })

  it('falls back to the raw href when there is no uddg redirect param', () => {
    const results = parseDuckDuckGoResults(FIXTURE)
    expect(results[1]?.url).toBe('https://direct.example.org/two')
    expect(results[1]?.snippet).toBe('Second snippet.')
  })

  it('decodes HTML entities in titles', () => {
    const results = parseDuckDuckGoResults(FIXTURE)
    expect(results[2]?.title).toBe('Ad title with "quotes"')
  })

  it('returns an empty array when no results are present', () => {
    expect(parseDuckDuckGoResults('<html><body>No results.</body></html>')).toEqual([])
  })

  it('drops result URLs whose scheme is not http(s)', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="mailto:foo@bar.com">Email me</a>
        <a class="result__snippet">Snippet for mail</a>
      </div>
      <div class="result">
        <a class="result__a" href="javascript:alert(1)">Hostile</a>
        <a class="result__snippet">Snippet for js</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.com/legit">Legit</a>
        <a class="result__snippet">Snippet for legit</a>
      </div>
    `
    const out = parseDuckDuckGoResults(html)
    expect(out).toHaveLength(1)
    expect(out[0]?.url).toBe('https://example.com/legit')
    expect(out[0]?.snippet).toBe('Snippet for legit')
  })
})

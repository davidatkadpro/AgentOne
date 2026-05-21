import { describe, it, expect } from 'vitest'
import { parseHermesToolCalls } from '@/providers/hermes-tool-call-parser.js'

describe('parseHermesToolCalls', () => {
  it('returns the original content untouched when no <tool_call> is present', () => {
    const content = 'Just a regular reply with no tool calls.'
    const r = parseHermesToolCalls(content)
    expect(r.toolCalls).toEqual([])
    expect(r.cleanedContent).toBe(content)
  })

  it('extracts a single <function=...><parameter=...> block', () => {
    const content = `
Now I'll call the tool.

<tool_call>
<function=consult_expert>
<parameter=expert>
openrouter-claude-sonnet
</parameter>
<parameter=question>
What is 2+2?
</parameter>
<parameter=context>
basic math
</parameter>
</function>
</tool_call>
`
    const r = parseHermesToolCalls(content)
    expect(r.toolCalls).toHaveLength(1)
    const tc = r.toolCalls[0]!
    expect(tc.type).toBe('function')
    expect(tc.function.name).toBe('consult_expert')
    expect(JSON.parse(tc.function.arguments)).toEqual({
      expert: 'openrouter-claude-sonnet',
      question: 'What is 2+2?',
      context: 'basic math',
    })
    expect(r.cleanedContent).toBe("Now I'll call the tool.")
  })

  it('extracts multiple <tool_call> blocks in order', () => {
    const content = `
<tool_call><function=a><parameter=x>1</parameter></function></tool_call>
some prose between
<tool_call><function=b><parameter=y>2</parameter></function></tool_call>
trailing
`
    const r = parseHermesToolCalls(content)
    expect(r.toolCalls.map((t) => t.function.name)).toEqual(['a', 'b'])
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ x: '1' })
    expect(JSON.parse(r.toolCalls[1]!.function.arguments)).toEqual({ y: '2' })
    expect(r.cleanedContent).toContain('some prose between')
    expect(r.cleanedContent).toContain('trailing')
    expect(r.cleanedContent).not.toContain('<tool_call>')
  })

  it('extracts the JSON-inside-tool_call variant', () => {
    const content =
      '<tool_call>{"name":"search_history","arguments":{"query":"colour","limit":5}}</tool_call>'
    const r = parseHermesToolCalls(content)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]!.function.name).toBe('search_history')
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({
      query: 'colour',
      limit: 5,
    })
    expect(r.cleanedContent).toBe('')
  })

  it('accepts `parameters` as an alias for `arguments` in the JSON variant', () => {
    const content =
      '<tool_call>{"name":"t","parameters":{"a":1}}</tool_call>'
    const r = parseHermesToolCalls(content)
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ a: 1 })
  })

  it('passes through a pre-stringified `arguments` blob', () => {
    const content =
      '<tool_call>{"name":"t","arguments":"{\\"a\\":1}"}</tool_call>'
    const r = parseHermesToolCalls(content)
    expect(r.toolCalls[0]!.function.arguments).toBe('{"a":1}')
  })

  it('leaves malformed <tool_call> blocks in place when neither variant matches', () => {
    const content = '<tool_call>not xml, not json</tool_call>'
    const r = parseHermesToolCalls(content)
    expect(r.toolCalls).toHaveLength(0)
    expect(r.cleanedContent).toBe(content)
  })

  it('collapses runs of blank lines left behind by stripped blocks', () => {
    const content = `before


<tool_call><function=t><parameter=a>1</parameter></function></tool_call>


after`
    const r = parseHermesToolCalls(content)
    expect(r.toolCalls).toHaveLength(1)
    // The stripped block leaves >2 blank lines in a row; collapse to <=2.
    expect(r.cleanedContent.match(/\n{3,}/)).toBeNull()
  })

  it('handles parameter values with embedded angle brackets', () => {
    const content = `<tool_call>
<function=write_file>
<parameter=content>
const x = a < b ? 1 : 2
</parameter>
<parameter=path>
notes.ts
</parameter>
</function>
</tool_call>`
    const r = parseHermesToolCalls(content)
    expect(r.toolCalls).toHaveLength(1)
    const args = JSON.parse(r.toolCalls[0]!.function.arguments)
    expect(args.path).toBe('notes.ts')
    expect(args.content).toBe('const x = a < b ? 1 : 2')
  })

  it('synthesises unique tool call ids', () => {
    const content =
      '<tool_call><function=a></function></tool_call><tool_call><function=b></function></tool_call>'
    const r = parseHermesToolCalls(content)
    expect(r.toolCalls).toHaveLength(2)
    expect(r.toolCalls[0]!.id).not.toBe(r.toolCalls[1]!.id)
    expect(r.toolCalls[0]!.id).toMatch(/^hermes_/)
  })
})

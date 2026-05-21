import type { ToolCallSpec } from '../core/types.js'

/**
 * Some local instruction-tuned models (notably qwen3-family) occasionally
 * regress from native OpenAI-format tool calls into Hermes-style text
 * emission:
 *
 *   <tool_call>
 *   <function=tool_name>
 *   <parameter=p1>value</parameter>
 *   <parameter=p2>value</parameter>
 *   </function>
 *   </tool_call>
 *
 * or, less commonly, a JSON-in-XML variant:
 *
 *   <tool_call>{"name":"tool_name","arguments":{"p1":"value"}}</tool_call>
 *
 * This parser scans assembled assistant content for both variants and lifts
 * them into native ToolCallSpec entries so the orchestrator can dispatch them
 * normally. The matched XML is stripped from the cleaned content.
 *
 * Behaviour is conservative — unparseable `<tool_call>` blocks are left in
 * place so the surface text still surfaces the model's intent to the user.
 */
export interface ParsedHermes {
  toolCalls: ToolCallSpec[]
  cleanedContent: string
}

export function parseHermesToolCalls(content: string): ParsedHermes {
  if (!content.includes('<tool_call>')) {
    return { toolCalls: [], cleanedContent: content }
  }
  const toolCalls: ToolCallSpec[] = []
  // Non-greedy outer match — handles multiple blocks in one response.
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/g
  const cleaned = content.replace(blockRe, (full, inner: string) => {
    const parsed = parseInner(inner)
    if (parsed) {
      toolCalls.push(parsed)
      return ''
    }
    return full
  })
  return {
    toolCalls,
    cleanedContent: collapseBlankRuns(cleaned).trim(),
  }
}

function parseInner(inner: string): ToolCallSpec | null {
  const xmlForm = parseFunctionParameterForm(inner)
  if (xmlForm) return xmlForm
  const jsonForm = parseJsonForm(inner)
  if (jsonForm) return jsonForm
  return null
}

/** Variant: <function=NAME>...<parameter=PNAME>val</parameter>...</function> */
function parseFunctionParameterForm(inner: string): ToolCallSpec | null {
  const fnMatch = inner.match(/<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/)
  if (!fnMatch) return null
  const name = (fnMatch[1] ?? '').trim()
  if (!name) return null
  const body = fnMatch[2] ?? ''
  const args: Record<string, string> = {}
  const paramRe = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g
  let m: RegExpExecArray | null
  while ((m = paramRe.exec(body)) !== null) {
    const key = (m[1] ?? '').trim()
    if (!key) continue
    args[key] = (m[2] ?? '').trim()
  }
  return {
    id: synthId(),
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

/** Variant: a JSON object inside <tool_call>...</tool_call>. */
function parseJsonForm(inner: string): ToolCallSpec | null {
  const trimmed = inner.trim()
  if (!trimmed.startsWith('{')) return null
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>
  const name = typeof obj.name === 'string' ? obj.name : null
  if (!name) return null
  // Accept either `arguments` or `parameters`. Stringify objects; pass
  // through pre-stringified arg blobs.
  const raw = obj.arguments ?? obj.parameters
  const argsStr =
    typeof raw === 'string' ? raw : raw === undefined ? '{}' : JSON.stringify(raw)
  return {
    id: synthId(),
    type: 'function',
    function: { name, arguments: argsStr },
  }
}

let counter = 0
function synthId(): string {
  counter = (counter + 1) % 0xffffffff
  return `hermes_${Date.now().toString(36)}_${counter.toString(36)}`
}

/** Collapse runs of 3+ blank lines (left behind after stripping XML) into 2. */
function collapseBlankRuns(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n')
}

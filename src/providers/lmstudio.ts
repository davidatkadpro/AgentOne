import { setTimeout as delay } from 'node:timers/promises'
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  Message,
  ToolCallSpec,
} from '../core/types.js'
import {
  ProviderError,
  type EmbedRequest,
  type EmbedResponse,
  type Provider,
  type ProviderCapabilities,
} from './base.js'
import { parseHermesToolCalls } from './hermes-tool-call-parser.js'
import { HermesStreamFilter } from './hermes-stream-filter.js'

export interface LMStudioConfig {
  baseUrl: string
  fetchImpl?: typeof fetch
  maxRetries?: number
}

interface OpenAIChatResponse {
  choices: Array<{
    message?: {
      content?: string
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

interface OpenAIToolCall {
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

interface OpenAIToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta?: {
      content?: string
      /** Reasoning models (qwen3.x, deepseek) emit the chain-of-thought here. */
      reasoning_content?: string
      tool_calls?: OpenAIToolCallDelta[]
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

export class LMStudioProvider implements Provider {
  readonly id = 'lmstudio'
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    tools: true,
    embeddings: true,
  }
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number

  constructor(private readonly config: LMStudioConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
    this.maxRetries = config.maxRetries ?? 3
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    if (req.input.length === 0) {
      return { model: req.model, embeddings: [], tokens: 0 }
    }
    const res = await this.callWithRetry('/embeddings', {
      model: req.model,
      input: req.input,
    })
    const json = (await res.json()) as {
      model?: string
      data?: Array<{ embedding: number[]; index?: number }>
      usage?: { total_tokens?: number }
    }
    if (!Array.isArray(json.data)) {
      throw new ProviderError('Embeddings response missing data array', 'BAD_RESPONSE')
    }
    // Preserve input order: OpenAI guarantees `index`, but some servers omit
    // it — fall back to the array order when missing.
    const ordered = [...json.data]
    if (ordered.every((d) => typeof d.index === 'number')) {
      ordered.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    }
    return {
      model: json.model ?? req.model,
      embeddings: ordered.map((d) => d.embedding),
      tokens: json.usage?.total_tokens ?? 0,
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.callWithRetry('/chat/completions', this.toBody({ req, stream: false }))
    const json = (await res.json()) as OpenAIChatResponse
    const choice = json.choices?.[0]
    if (!choice) throw new ProviderError('No choices in response', 'BAD_RESPONSE')
    return {
      content: choice.message?.content ?? '',
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      finishReason: mapFinishReason(choice.finish_reason),
      toolCalls: choice.message?.tool_calls?.map(normaliseToolCall),
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const body = this.toBody({ req, stream: true })
    const debug = process.env.LMSTUDIO_DEBUG === '1'
    if (debug) {
      // eslint-disable-next-line no-console
      console.error('[lmstudio.stream] request body:', JSON.stringify(body).slice(0, 2000))
    }
    const res = await this.callWithRetry('/chat/completions', body)
    if (!res.body) throw new ProviderError('No response body for stream', 'BAD_RESPONSE')

    let inputTokens = 0
    let outputTokens = 0
    let finishReason: 'stop' | 'length' | 'tool_calls' | 'error' = 'stop'
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>()
    let chunkCount = 0
    let contentCount = 0
    let toolCallChunkCount = 0
    // Reasoning models (qwen3.x, deepseek-r) sometimes put the entire response
    // in `reasoning_content` and never emit `content`. We buffer it as a
    // fallback so we don't silently drop the answer. Capped to bound memory
    // on pathologically long chains-of-thought.
    const REASONING_MAX_BYTES = 256 * 1024
    let reasoningBuffer = ''
    let reasoningTruncated = false
    let contentEmitted = false
    // Route content deltas through a streaming filter that suppresses
    // <tool_call> XML in the live UI (the end-of-stream Hermes parser still
    // operates on the full assembled buffer for promotion to native calls).
    const hermesStream = new HermesStreamFilter()

    for await (const event of parseSSE(res.body)) {
      if (event === '[DONE]') break
      chunkCount++
      let parsed: OpenAIStreamChunk
      try {
        parsed = JSON.parse(event) as OpenAIStreamChunk
      } catch (err) {
        if (debug) {
          // eslint-disable-next-line no-console
          console.error('[lmstudio.stream] JSON.parse failure:', (err as Error).message, 'event:', event.slice(0, 200))
        }
        continue
      }
      const choice = parsed.choices?.[0]
      if (!choice) continue
      const deltaText = choice.delta?.content ?? ''
      if (deltaText) {
        contentCount++
        contentEmitted = true
        const filtered = hermesStream.push(deltaText)
        if (filtered) yield { delta: filtered, done: false }
      }
      const reasoningDelta = choice.delta?.reasoning_content ?? ''
      if (reasoningDelta && !reasoningTruncated) {
        if (reasoningBuffer.length + reasoningDelta.length <= REASONING_MAX_BYTES) {
          reasoningBuffer += reasoningDelta
        } else {
          reasoningBuffer += reasoningDelta.slice(
            0,
            REASONING_MAX_BYTES - reasoningBuffer.length,
          )
          reasoningTruncated = true
        }
      }

      if (choice.delta?.tool_calls) {
        toolCallChunkCount++
        for (const tc of choice.delta.tool_calls) {
          const buf = toolCallBuffers.get(tc.index) ?? { id: '', name: '', arguments: '' }
          if (tc.id) buf.id = tc.id
          if (tc.function?.name) buf.name += tc.function.name
          if (tc.function?.arguments) buf.arguments += tc.function.arguments
          toolCallBuffers.set(tc.index, buf)
        }
      }

      if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason)
      if (parsed.usage) {
        inputTokens = parsed.usage.prompt_tokens ?? inputTokens
        outputTokens = parsed.usage.completion_tokens ?? outputTokens
      }
    }
    const nativeToolCalls = assembleToolCalls(toolCallBuffers)

    // Reasoning-model fallback: if the model produced *only* reasoning and no
    // content (qwen3.x, deepseek-r occasionally do this on tool-result
    // continuations, and qwen3 sometimes emits Hermes-format tool calls in
    // reasoning_content rather than content), promote the reasoning into the
    // content stream. We route it through the same Hermes filter so any
    // <tool_call> XML hiding inside doesn't leak to the UI, then flush.
    let usedReasoningFallback = false
    if (
      !contentEmitted &&
      finishReason === 'stop' &&
      (!nativeToolCalls || nativeToolCalls.length === 0) &&
      reasoningBuffer.trim().length > 0
    ) {
      usedReasoningFallback = true
      const filtered = hermesStream.push(reasoningBuffer)
      if (filtered) yield { delta: filtered, done: false }
    }

    // Flush any safe content the filter was still holding (e.g. a trailing
    // partial-open-tag prefix that turned out not to be a real open).
    const tail = hermesStream.flush()
    if (tail) yield { delta: tail, done: false }

    // Hermes-format fallback: scan the full assembled content for <tool_call>
    // XML blocks (including the reasoning content if we promoted it) and lift
    // them into native tool_calls. qwen3 regresses to text-emission for some
    // tools; this catches that without changing the model.
    const hermes = parseHermesToolCalls(hermesStream.assembled)
    const toolCalls =
      hermes.toolCalls.length === 0
        ? nativeToolCalls
        : [...(nativeToolCalls ?? []), ...hermes.toolCalls]
    // If Hermes blocks were promoted, also adjust finishReason so the
    // orchestrator continues the tool loop instead of treating this as the
    // model's final turn.
    if (hermes.toolCalls.length > 0 && finishReason === 'stop') {
      finishReason = 'tool_calls'
    }

    if (debug) {
      // eslint-disable-next-line no-console
      console.error(
        `[lmstudio.stream] chunks=${chunkCount} content=${contentCount} toolCallChunks=${toolCallChunkCount} reasoningChars=${reasoningBuffer.length} reasoningFallback=${usedReasoningFallback} hermesPromoted=${hermes.toolCalls.length} finish=${finishReason} in=${inputTokens} out=${outputTokens}`,
      )
    }

    const finalChunk: ChatChunk = {
      delta: '',
      done: true,
      inputTokens,
      outputTokens,
      finishReason,
      ...(toolCalls && { toolCalls }),
    }
    if (hermes.toolCalls.length > 0) {
      finalChunk.replaceContent = hermes.cleanedContent
    }
    yield finalChunk
  }

  private toBody({ req, stream }: { req: ChatRequest; stream: boolean }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(serialiseMessage),
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 2048,
      top_p: req.topP ?? 1,
      stream,
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools
      body.tool_choice = req.toolChoice ?? 'auto'
    }
    return body
  }

  private async callWithRetry(path: string, body: unknown): Promise<Response> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (res.ok) return res
        if (TRANSIENT_STATUSES.has(res.status) && attempt < this.maxRetries - 1) {
          lastError = new ProviderError(
            `HTTP ${res.status} from LM Studio`,
            res.status === 429 ? 'RATE_LIMITED' : 'NETWORK',
          )
          await delay(backoff(attempt))
          continue
        }
        const text = await res.text().catch(() => '')
        throw new ProviderError(
          `HTTP ${res.status}: ${text.slice(0, 500)}`,
          res.status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST',
        )
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'BAD_REQUEST') throw err
        lastError = err
        if (attempt < this.maxRetries - 1) {
          await delay(backoff(attempt))
          continue
        }
      }
    }
    if (lastError instanceof ProviderError) throw lastError
    throw new ProviderError('LM Studio unreachable', 'NETWORK', lastError)
  }
}

function normaliseToolCall(tc: OpenAIToolCall): ToolCallSpec {
  return {
    id: tc.id ?? '',
    type: 'function',
    function: {
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '',
    },
  }
}

function assembleToolCalls(
  buffers: Map<number, { id: string; name: string; arguments: string }>,
): ToolCallSpec[] | undefined {
  if (buffers.size === 0) return undefined
  const indices = [...buffers.keys()].sort((a, b) => a - b)
  return indices.map((i) => {
    const buf = buffers.get(i)!
    return {
      id: buf.id,
      type: 'function',
      function: { name: buf.name, arguments: buf.arguments },
    }
  })
}

/**
 * OpenAI-compatible wire format requires omitting null content on assistant
 * messages that carry tool_calls (some endpoints reject null explicitly), and
 * requires `tool_call_id` on tool-role messages.
 */
function serialiseMessage(m: Message): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role }
  if (m.content !== null && m.content !== undefined) out.content = m.content
  if (m.tool_calls && m.tool_calls.length > 0) out.tool_calls = m.tool_calls
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id
  if (m.name) out.name = m.name
  return out
}

function mapFinishReason(reason: string | null | undefined): 'stop' | 'length' | 'tool_calls' | 'error' {
  if (reason === 'length') return 'length'
  if (reason === 'tool_calls') return 'tool_calls'
  if (reason === 'stop' || reason === null || reason === undefined) return 'stop'
  return 'error'
}

function backoff(attempt: number): number {
  return Math.min(2000, 100 * 2 ** attempt)
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trimEnd()
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('data: ')) yield line.slice(6).trim()
      }
    }
    if (buffer.startsWith('data: ')) yield buffer.slice(6).trim()
  } finally {
    reader.releaseLock()
  }
}

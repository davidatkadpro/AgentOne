import { setTimeout as delay } from 'node:timers/promises'
import type { ChatChunk, ChatRequest, ChatResponse } from '../core/types.js'
import { ProviderError, type Provider, type ProviderCapabilities } from './base.js'

export interface LMStudioConfig {
  baseUrl: string
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch
  /** Optional max attempts on transient network errors. Defaults to 3. */
  maxRetries?: number
}

interface OpenAIChatResponse {
  choices: Array<{
    message?: { content?: string }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta?: { content?: string }
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
  readonly capabilities: ProviderCapabilities = { streaming: true, tools: false }
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number

  constructor(private readonly config: LMStudioConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
    this.maxRetries = config.maxRetries ?? 3
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
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const res = await this.callWithRetry('/chat/completions', this.toBody({ req, stream: true }))
    if (!res.body) throw new ProviderError('No response body for stream', 'BAD_RESPONSE')

    let inputTokens = 0
    let outputTokens = 0
    let finishReason: 'stop' | 'length' | 'error' = 'stop'

    for await (const event of parseSSE(res.body)) {
      if (event === '[DONE]') break
      let parsed: OpenAIStreamChunk
      try {
        parsed = JSON.parse(event) as OpenAIStreamChunk
      } catch {
        continue
      }
      const choice = parsed.choices?.[0]
      if (!choice) continue
      const deltaText = choice.delta?.content ?? ''
      if (deltaText) yield { delta: deltaText, done: false }
      if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason)
      if (parsed.usage) {
        inputTokens = parsed.usage.prompt_tokens ?? inputTokens
        outputTokens = parsed.usage.completion_tokens ?? outputTokens
      }
    }

    yield { delta: '', done: true, inputTokens, outputTokens, finishReason }
  }

  private toBody({ req, stream }: { req: ChatRequest; stream: boolean }): Record<string, unknown> {
    return {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 2048,
      top_p: req.topP ?? 1,
      stream,
    }
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

function mapFinishReason(reason: string | null | undefined): 'stop' | 'length' | 'error' {
  if (reason === 'length') return 'length'
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

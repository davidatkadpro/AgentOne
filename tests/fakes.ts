import type { ChatChunk, ChatRequest, ChatResponse } from '../src/core/types.js'
import type { Provider, ProviderCapabilities } from '../src/providers/base.js'

export interface FakeProviderOptions {
  id?: string
  respond?: (req: ChatRequest) => string
  failWith?: Error
  empty?: boolean
  /** Reported USD cost on chat() responses — mirrors OpenRouter's usage.cost. */
  costUsd?: number
}

export class FakeProvider implements Provider {
  readonly id: string
  readonly capabilities: ProviderCapabilities = { streaming: true, tools: false }
  readonly calls: ChatRequest[] = []

  constructor(private readonly opts: FakeProviderOptions = {}) {
    this.id = opts.id ?? 'fake'
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req)
    if (this.opts.failWith) throw this.opts.failWith
    const content = this.opts.empty ? '' : (this.opts.respond?.(req) ?? 'OK')
    const out: ChatResponse = { content, inputTokens: 0, outputTokens: 0, finishReason: 'stop' }
    if (this.opts.costUsd !== undefined) out.costUsd = this.opts.costUsd
    return out
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.calls.push(req)
    if (this.opts.failWith) throw this.opts.failWith
    const content = this.opts.empty ? '' : (this.opts.respond?.(req) ?? 'OK')
    yield { delta: content, done: false }
    yield {
      delta: '',
      done: true,
      inputTokens: 0,
      outputTokens: content.length,
      finishReason: 'stop',
    }
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function sseResponse(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const line of lines) controller.enqueue(enc.encode(line))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

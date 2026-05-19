import type { ChatChunk, ChatRequest, ChatResponse } from '../src/core/types.js'
import type { Provider, ProviderCapabilities } from '../src/providers/base.js'

export interface FakeProviderOptions {
  respond?: (req: ChatRequest) => string
  failWith?: Error
  empty?: boolean
}

export class FakeProvider implements Provider {
  readonly id = 'fake'
  readonly capabilities: ProviderCapabilities = { streaming: true, tools: false }
  readonly calls: ChatRequest[] = []

  constructor(private readonly opts: FakeProviderOptions = {}) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req)
    if (this.opts.failWith) throw this.opts.failWith
    const content = this.opts.empty ? '' : (this.opts.respond?.(req) ?? 'OK')
    return { content, inputTokens: 0, outputTokens: 0, finishReason: 'stop' }
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

import type { ChatChunk, ChatRequest, ChatResponse } from '../core/types.js'

export interface ProviderCapabilities {
  streaming: boolean
  tools: boolean
}

export interface Provider {
  readonly id: string
  readonly capabilities: ProviderCapabilities

  /** Non-streaming chat. Returns the full response. */
  chat(req: ChatRequest): Promise<ChatResponse>

  /** Streaming chat. Yields deltas; the final chunk has done=true and totals. */
  stream(req: ChatRequest): AsyncIterable<ChatChunk>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NETWORK'
      | 'BAD_RESPONSE'
      | 'RATE_LIMITED'
      | 'TIMEOUT'
      | 'BAD_REQUEST'
      | 'UNKNOWN',
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

import type { ChatChunk, ChatRequest, ChatResponse } from '../core/types.js'

export interface ProviderCapabilities {
  streaming: boolean
  tools: boolean
}

export interface EmbedRequest {
  model: string
  input: string[]
}

export interface EmbedResponse {
  model: string
  /** One vector per input, in order. */
  embeddings: number[][]
  /** Total tokens consumed across inputs (provider-reported, may be 0). */
  tokens: number
}

export interface Provider {
  readonly id: string
  readonly capabilities: ProviderCapabilities

  /** Non-streaming chat. Returns the full response. */
  chat(req: ChatRequest): Promise<ChatResponse>

  /** Streaming chat. Yields deltas; the final chunk has done=true and totals. */
  stream(req: ChatRequest): AsyncIterable<ChatChunk>

  /**
   * Batch-embed text inputs. Optional — providers without an embeddings
   * endpoint may omit this. Callers should truthy-check `provider.embed`
   * directly rather than relying on a separate capabilities flag.
   */
  embed?(req: EmbedRequest): Promise<EmbedResponse>
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

import type { ChatChunk, ChatRequest, ChatResponse, ModelProfile } from '../src/core/types.js'
import type { Provider, ProviderCapabilities } from '../src/providers/base.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { ExpertSpendTracker } from '../src/skills/expert-spend.js'
import { EventBus } from '../src/core/events.js'
import type { StorageAdapter } from '../src/storage/adapter.js'
import type { WikiEngine } from '../src/memory/wiki/engine.js'
import type { ConversationStore } from '../src/storage/sqlite.js'
import type { HybridRecall } from '../src/search/hybrid.js'
import type { PermissionGate } from '../src/profiles/permission-gate.js'
import type { ToolContext, ToolServices } from '../src/skills/tool.js'

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

/**
 * Build a stub ToolServices with empty defaults for unused fields.
 * Tests that only exercise one or two services pass overrides to set just
 * what they care about, instead of having to fabricate every dependency.
 */
export function fakeServices(overrides: Partial<ToolServices> = {}): ToolServices {
  return {
    storage: {} as unknown as StorageAdapter,
    wiki: {} as unknown as WikiEngine,
    conversationStore: {} as unknown as ConversationStore,
    recall: {} as unknown as HybridRecall,
    providers: new ProviderRegistry(),
    modelProfiles: new Map<string, ModelProfile>(),
    eventBus: new EventBus(),
    ...overrides,
  }
}

/**
 * Build a stub ToolContext. `services` overrides are merged into the
 * defaults from `fakeServices()`. `permissions` defaults to a stub PermissionGate.
 */
export function fakeToolContext(opts: {
  sessionId?: string
  agentProfile?: string
  services?: Partial<ToolServices>
  permissions?: PermissionGate
  expertSpend?: ExpertSpendTracker
} = {}): ToolContext {
  return {
    sessionId: opts.sessionId ?? 's1',
    agentProfile: opts.agentProfile ?? 'test',
    services: fakeServices(opts.services),
    permissions: opts.permissions ?? ({} as unknown as PermissionGate),
    expertSpend: opts.expertSpend ?? new ExpertSpendTracker(),
  }
}

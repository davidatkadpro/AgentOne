export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCallSpec {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface Message {
  role: Role
  content: string | null
  tool_calls?: ToolCallSpec[]
  tool_call_id?: string
  name?: string
}

export interface Turn {
  id: string
  sessionId: string
  role: Role
  content: string
  tokenCount: number
  createdAt: number
  compressedFrom?: string | null
  toolCallId?: string | null
}

export interface Session {
  id: string
  title: string | null
  agentProfile: string
  createdAt: number
}

export interface ModelProfile {
  id: string
  provider: 'lmstudio' | 'openrouter'
  model: string
  role: 'general' | 'compressor' | 'embedding' | 'expert'
  contextWindow: number
  params: {
    temperature?: number
    maxTokens?: number
    topP?: number
  }
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatRequest {
  model: string
  messages: Message[]
  temperature?: number
  maxTokens?: number
  topP?: number
  stream?: boolean
  tools?: ToolDefinition[]
  /** OpenAI 'auto' | 'none' | { type: 'function', function: { name } } */
  toolChoice?: 'auto' | 'none'
}

export interface ChatChunk {
  delta: string
  done: boolean
  inputTokens?: number
  outputTokens?: number
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'error'
  /** Present only on the final chunk (done=true). Assembled from streaming deltas. */
  toolCalls?: ToolCallSpec[]
}

export interface ChatResponse {
  content: string
  inputTokens: number
  outputTokens: number
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error'
  toolCalls?: ToolCallSpec[]
}

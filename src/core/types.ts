export type Role = 'system' | 'user' | 'assistant'

export interface Message {
  role: Role
  content: string
}

export interface Turn {
  id: string
  sessionId: string
  role: Role
  content: string
  tokenCount: number
  createdAt: number
  compressedFrom?: string | null
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

export interface ChatRequest {
  model: string
  messages: Message[]
  temperature?: number
  maxTokens?: number
  topP?: number
  stream?: boolean
}

export interface ChatChunk {
  delta: string
  done: boolean
  inputTokens?: number
  outputTokens?: number
  finishReason?: 'stop' | 'length' | 'error'
}

export interface ChatResponse {
  content: string
  inputTokens: number
  outputTokens: number
  finishReason: 'stop' | 'length' | 'error'
}

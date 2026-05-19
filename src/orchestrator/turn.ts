import type { ConversationStore } from '../storage/sqlite.js'
import { turnsToMessages, sumTurnTokens } from '../storage/sqlite.js'
import type { ContextManager } from '../context/context-manager.js'
import type { Provider } from '../providers/base.js'
import type { Message, ModelProfile } from '../core/types.js'
import { EventBus } from '../core/events.js'
import { randomUUID } from 'node:crypto'

export interface OrchestratorConfig {
  store: ConversationStore
  contextManager: ContextManager
  provider: Provider
  model: ModelProfile
  eventBus: EventBus
  systemMessage: Message
}

export interface TurnHandle {
  assistantTurnId: string
  stream: AsyncIterable<string>
}

/**
 * Minimal turn loop for M1: persist user turn, prepare context (compress if
 * needed), stream the assistant response, persist on finalisation. No tool
 * use yet — that arrives with the Skill system in M3.
 */
export class Orchestrator {
  constructor(private readonly cfg: OrchestratorConfig) {}

  async handleUserMessage(sessionId: string, userText: string): Promise<TurnHandle> {
    const userTurn = this.cfg.store.appendTurn({
      sessionId,
      role: 'user',
      content: userText,
    })
    await this.cfg.eventBus.emit({
      type: 'message.user.received',
      sessionId,
      turnId: userTurn.id,
      ts: Date.now(),
    })

    const turns = this.cfg.store.listTurns(sessionId)
    const history = turnsToMessages(turns)
    const historyTokens = sumTurnTokens(turns)
    const prepared = await this.cfg.contextManager.prepare(
      sessionId,
      this.cfg.systemMessage,
      history,
      { historyTokens },
    )

    const assistantTurnId = randomUUID()
    await this.cfg.eventBus.emit({
      type: 'message.assistant.started',
      sessionId,
      turnId: assistantTurnId,
      ts: Date.now(),
    })

    const stream = this.streamAssistant(sessionId, assistantTurnId, prepared.messages)
    return { assistantTurnId, stream }
  }

  private async *streamAssistant(
    sessionId: string,
    assistantTurnId: string,
    messages: Message[],
  ): AsyncIterable<string> {
    let collected = ''
    let inputTokens = 0
    let outputTokens = 0
    try {
      for await (const chunk of this.cfg.provider.stream({
        model: this.cfg.model.model,
        messages,
        temperature: this.cfg.model.params.temperature ?? 0.4,
        maxTokens: this.cfg.model.params.maxTokens ?? 2048,
        topP: this.cfg.model.params.topP ?? 1,
      })) {
        if (chunk.delta) {
          collected += chunk.delta
          // Fire-and-forget: delta events have very high frequency. Awaiting
          // would serialise SSE forwarding behind every observer and stall
          // token throughput.
          void this.cfg.eventBus.emit({
            type: 'message.assistant.delta',
            sessionId,
            turnId: assistantTurnId,
            delta: chunk.delta,
          })
          yield chunk.delta
        }
        if (chunk.done) {
          inputTokens = chunk.inputTokens ?? 0
          outputTokens = chunk.outputTokens ?? 0
        }
      }
    } finally {
      if (collected.length > 0) {
        this.cfg.store.appendTurn({
          sessionId,
          role: 'assistant',
          content: collected,
        })
      }
      await this.cfg.eventBus.emit({
        type: 'message.assistant.completed',
        sessionId,
        turnId: assistantTurnId,
        inputTokens,
        outputTokens,
        ts: Date.now(),
      })
    }
  }
}

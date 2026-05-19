import { encode } from 'gpt-tokenizer'
import type { Message } from './types.js'

// gpt-tokenizer is cl100k_base; local LM Studio models use different tokenizers,
// so this is an estimate. The 4-token-per-message overhead matches OpenAI's
// public guidance for the chat completions framing.
const MESSAGE_OVERHEAD = 4
const PRIMING_OVERHEAD = 2

export function countTokens(text: string): number {
  if (!text) return 0
  return encode(text).length
}

export function countMessageTokens(message: Message): number {
  const contentTokens = countTokens(message.content ?? '')
  let toolTokens = 0
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      toolTokens += countTokens(tc.function.name) + countTokens(tc.function.arguments) + 8
    }
  }
  if (message.tool_call_id) toolTokens += 6
  return contentTokens + toolTokens + MESSAGE_OVERHEAD
}

export function countMessagesTokens(messages: Message[]): number {
  let total = PRIMING_OVERHEAD
  for (const m of messages) total += countMessageTokens(m)
  return total
}

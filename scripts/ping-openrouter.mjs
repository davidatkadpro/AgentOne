#!/usr/bin/env node
/**
 * Direct OpenRouterProvider sanity check. Sends one minimal chat() call
 * and prints the reply + reported cost. Used after M8 to verify auth,
 * body shape, and cost extraction against the real API without going
 * through the chat loop.
 *
 * Usage:
 *   node --env-file-if-exists=.env --import tsx scripts/ping-openrouter.mjs
 *
 * Cost: ~$0.001 with Claude Sonnet 4.6 + max_tokens=20.
 */
import { OpenRouterProvider } from '../src/providers/openrouter.ts'

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error('OPENROUTER_API_KEY not set in environment')
  process.exit(1)
}

const provider = new OpenRouterProvider({
  baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  apiKey,
  appTitle: 'AgentOne-Smoke',
})

console.log('Sending one-shot ping to anthropic/claude-sonnet-4.6 ...')
const t0 = Date.now()
const res = await provider.chat({
  model: 'anthropic/claude-sonnet-4.6',
  messages: [
    { role: 'user', content: 'Reply with exactly the single word: OK' },
  ],
  maxTokens: 20,
  temperature: 0,
})
const elapsed = Date.now() - t0

console.log(`reply         : ${JSON.stringify(res.content)}`)
console.log(`finishReason  : ${res.finishReason}`)
console.log(`inputTokens   : ${res.inputTokens}`)
console.log(`outputTokens  : ${res.outputTokens}`)
console.log(`costUsd       : ${res.costUsd !== undefined ? '$' + res.costUsd.toFixed(6) : '(not reported)'}`)
console.log(`elapsed       : ${elapsed}ms`)

if (res.content.toUpperCase().includes('OK')) {
  console.log('\nPASS: provider returned a real response.')
  process.exit(0)
} else {
  console.log('\nWARN: response did not contain "OK" — auth + transport worked but content is unexpected.')
  process.exit(0)
}

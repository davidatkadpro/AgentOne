import { describe, it, expect, vi } from 'vitest'
import { OpenRouterProvider } from '@/providers/openrouter.js'
import { ProviderError } from '@/providers/base.js'
import { jsonResponse } from './fakes.js'

describe('OpenRouterProvider', () => {
  it('throws when constructed without an apiKey', () => {
    expect(
      () =>
        new OpenRouterProvider({
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: '',
        }),
    ).toThrow(/apiKey/)
  })

  it('sends Authorization, X-Title, and usage.include=true on chat', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0123 },
      }),
    )
    const provider = new OpenRouterProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      appTitle: 'AgentOne-Test',
      httpReferer: 'https://example.local',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const res = await provider.chat({
      model: 'anthropic/claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(res.content).toBe('reply')
    expect(res.inputTokens).toBe(10)
    expect(res.outputTokens).toBe(5)
    expect(res.costUsd).toBe(0.0123)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer sk-test')
    expect(init.headers['X-Title']).toBe('AgentOne-Test')
    expect(init.headers['HTTP-Referer']).toBe('https://example.local')

    const body = JSON.parse(init.body)
    expect(body.model).toBe('anthropic/claude-sonnet-4.6')
    expect(body.usage).toEqual({ include: true })
    expect(body.stream).toBe(false)
  })

  it('omits costUsd when the response has no usage.cost', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    )
    const provider = new OpenRouterProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const res = await provider.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.costUsd).toBeUndefined()
  })

  it('retries 5xx with backoff', async () => {
    let calls = 0
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls++
      if (calls < 3) return new Response('upstream', { status: 503 })
      return jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    })
    const provider = new OpenRouterProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 5,
    })
    const res = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.content).toBe('ok')
    expect(calls).toBe(3)
  })

  it('does not retry 400 client errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad model', { status: 400 }))
    const provider = new OpenRouterProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 5,
    })
    await expect(
      provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(ProviderError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not expose an embed() method (OpenRouter has no embeddings endpoint)', () => {
    const provider = new OpenRouterProvider({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk',
    })
    expect((provider as { embed?: unknown }).embed).toBeUndefined()
  })
})

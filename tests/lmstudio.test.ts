import { describe, it, expect, vi } from 'vitest'
import { LMStudioProvider } from '@/providers/lmstudio.js'
import { ProviderError } from '@/providers/base.js'
import { jsonResponse, sseResponse } from './fakes.js'

describe('LMStudioProvider.chat', () => {
  it('posts the chat completions request and returns text + usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      }),
    )
    const provider = new LMStudioProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.chat({
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(result.content).toBe('Hello!')
    expect(result.inputTokens).toBe(12)
    expect(result.outputTokens).toBe(5)
    expect(result.finishReason).toBe('stop')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://localhost:1234/v1/chat/completions')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('test')
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }])
    expect(body.stream).toBe(false)
  })

  it('throws ProviderError("BAD_RESPONSE") when choices are missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }))
    const provider = new LMStudioProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(
      provider.chat({ model: 'test', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })

  it('retries transient 5xx errors with backoff', async () => {
    let calls = 0
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls++
      if (calls < 3) return new Response('upstream', { status: 503 })
      return jsonResponse({
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    })

    const provider = new LMStudioProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 5,
    })

    const result = await provider.chat({
      model: 't',
      messages: [{ role: 'user', content: 'Hi' }],
    })
    expect(result.content).toBe('OK')
    expect(calls).toBe(3)
  })

  it('does not retry 400 client errors', async () => {
    let calls = 0
    const fetchImpl = vi.fn().mockImplementation(async () => {
      calls++
      return new Response('bad model', { status: 400 })
    })

    const provider = new LMStudioProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 5,
    })

    await expect(
      provider.chat({ model: 't', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toBeInstanceOf(ProviderError)
    expect(calls).toBe(1)
  })

  it('surfaces a NETWORK error after exhausting retries', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const provider = new LMStudioProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
    })

    await expect(
      provider.chat({ model: 't', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({ code: 'NETWORK' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('LMStudioProvider.stream', () => {
  it('yields deltas from SSE chunks in order, then a final done chunk', async () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
      'data: {"choices":[{"delta":{"content":", "}}]}\n',
      'data: {"choices":[{"delta":{"content":"world."},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n',
      'data: [DONE]\n',
    ]
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(lines))
    const provider = new LMStudioProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const deltas: string[] = []
    let final: { inputTokens?: number; outputTokens?: number; done?: boolean } | null = null
    for await (const chunk of provider.stream({
      model: 't',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      if (chunk.done) final = chunk
      else if (chunk.delta) deltas.push(chunk.delta)
    }

    expect(deltas).toEqual(['Hello', ', ', 'world.'])
    expect(final?.done).toBe(true)
    expect(final?.inputTokens).toBe(3)
    expect(final?.outputTokens).toBe(4)

    const [, init] = fetchImpl.mock.calls[0]!
    expect(JSON.parse(init.body).stream).toBe(true)
  })

  it('throws when the stream body is missing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }))
    const provider = new LMStudioProvider({
      baseUrl: 'http://localhost:1234/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(async () => {
      for await (const _ of provider.stream({
        model: 't',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        void _
      }
    }).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })
})

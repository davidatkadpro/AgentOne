import { describe, it, expect } from 'vitest'
import {
  buildPassiveRecall,
  extractFtsQuery,
  type PassiveRecallConfig,
} from '@/context/passive-recall.js'
import { EventBus, type AgentEvent } from '@/core/events.js'
import type { WikiEngine } from '@/memory/wiki/engine.js'
import type { HybridRecall } from '@/search/hybrid.js'
import type { TurnSearchHit } from '@/storage/sqlite.js'

interface FakeWikiHit {
  path: string
  name: string
  snippet: string
}

function fakeWiki(hits: FakeWikiHit[] | (() => never)): WikiEngine {
  return {
    async search(): Promise<FakeWikiHit[]> {
      if (typeof hits === 'function') hits()
      return hits as FakeWikiHit[]
    },
  } as unknown as WikiEngine
}

function fakeRecall(hits: TurnSearchHit[] | (() => never)): HybridRecall {
  return {
    async searchHistory(): Promise<TurnSearchHit[]> {
      if (typeof hits === 'function') hits()
      return hits as TurnSearchHit[]
    },
  }
}

const baseCfg: PassiveRecallConfig = {
  enabled: true,
  wikiHits: 2,
  historyHits: 2,
  maxCharsPerHit: 240,
}

function makeTurnHit(overrides: Partial<TurnSearchHit> = {}): TurnSearchHit {
  return {
    turnId: 't1',
    sessionId: 'old',
    sessionTitle: 'Past chat',
    role: 'user',
    content: 'full content',
    snippet: 'matched snippet',
    createdAt: 0,
    score: 0,
    ...overrides,
  }
}

describe('buildPassiveRecall', () => {
  it('returns null when disabled', async () => {
    const res = await buildPassiveRecall(
      'anything',
      { ...baseCfg, enabled: false },
      { wiki: fakeWiki([]), recall: fakeRecall([]), sessionId: 's1' },
    )
    expect(res).toBeNull()
  })

  it('returns null when both lanes return zero hits', async () => {
    const res = await buildPassiveRecall('q', baseCfg, {
      wiki: fakeWiki([]),
      recall: fakeRecall([]),
      sessionId: 's1',
    })
    expect(res).toBeNull()
  })

  it('returns null on whitespace-only message without probing either lane', async () => {
    let probed = false
    const wiki = {
      async search() {
        probed = true
        return []
      },
    } as unknown as WikiEngine
    const res = await buildPassiveRecall('   \n  ', baseCfg, {
      wiki,
      recall: fakeRecall([]),
      sessionId: 's1',
    })
    expect(res).toBeNull()
    expect(probed).toBe(false)
  })

  it('formats wiki and history sources in the block', async () => {
    const res = await buildPassiveRecall('platypus', baseCfg, {
      wiki: fakeWiki([{ path: 'animals/platypus', name: 'Platypus', snippet: 'is a curious creature' }]),
      recall: fakeRecall([
        makeTurnHit({ turnId: 't1', sessionId: 'old', sessionTitle: 'Bio chat', snippet: 'monotreme facts' }),
      ]),
      sessionId: 'current',
    })
    expect(res).not.toBeNull()
    expect(res!.sources.length).toBe(2)
    expect(res!.sources[0]).toMatchObject({ kind: 'wiki', ref: 'animals/platypus' })
    expect(res!.sources[1]).toMatchObject({ kind: 'history', ref: 'old:t1' })
    expect(res!.block).toContain('## Possibly relevant context')
    expect(res!.block).toContain('animals/platypus')
    expect(res!.block).toContain('Bio chat')
  })

  it('truncates snippets to maxCharsPerHit', async () => {
    const long = 'x'.repeat(500)
    const res = await buildPassiveRecall('platypus', { ...baseCfg, maxCharsPerHit: 50 }, {
      wiki: fakeWiki([{ path: 'p', name: 'P', snippet: long }]),
      recall: fakeRecall([]),
      sessionId: 's',
    })
    expect(res!.sources[0].snippet.length).toBe(50)
    expect(res!.sources[0].snippet.endsWith('…')).toBe(true)
  })

  it('falls back to full content when snippet is empty (history lane)', async () => {
    const res = await buildPassiveRecall('q', baseCfg, {
      wiki: fakeWiki([]),
      recall: fakeRecall([makeTurnHit({ snippet: '', content: 'actual body text' })]),
      sessionId: 's',
    })
    expect(res!.sources[0].snippet).toBe('actual body text')
  })

  it('swallows wiki failure and still surfaces history results', async () => {
    const res = await buildPassiveRecall('q', baseCfg, {
      wiki: fakeWiki(() => {
        throw new Error('wiki DB locked')
      }),
      recall: fakeRecall([makeTurnHit()]),
      sessionId: 's',
    })
    expect(res).not.toBeNull()
    expect(res!.sources.length).toBe(1)
    expect(res!.sources[0].kind).toBe('history')
  })

  it('swallows history failure and still surfaces wiki results', async () => {
    const res = await buildPassiveRecall('platypus', baseCfg, {
      wiki: fakeWiki([{ path: 'p', name: 'P', snippet: 's' }]),
      recall: fakeRecall(() => {
        throw new Error('vector lane down')
      }),
      sessionId: 's',
    })
    expect(res).not.toBeNull()
    expect(res!.sources[0].kind).toBe('wiki')
  })

  it('skips the wiki lane entirely when wikiHits is 0', async () => {
    let wikiCalls = 0
    const wiki = {
      async search() {
        wikiCalls++
        return []
      },
    } as unknown as WikiEngine
    await buildPassiveRecall('q', { ...baseCfg, wikiHits: 0 }, {
      wiki,
      recall: fakeRecall([makeTurnHit()]),
      sessionId: 's',
    })
    expect(wikiCalls).toBe(0)
  })

  it('passes excludeSessionId so the current session is filtered from history', async () => {
    let captured: { excludeSessionId?: string } | null = null
    const recall: HybridRecall = {
      async searchHistory(opts): Promise<TurnSearchHit[]> {
        captured = opts as { excludeSessionId?: string }
        return []
      },
    }
    await buildPassiveRecall('q', baseCfg, {
      wiki: fakeWiki([]),
      recall,
      sessionId: 'current-session-id',
    })
    expect(captured).not.toBeNull()
    expect(captured!.excludeSessionId).toBe('current-session-id')
  })

  it('emits recall.injected with source summaries when a result is produced', async () => {
    const bus = new EventBus()
    const events: AgentEvent[] = []
    bus.on('recall.injected', (e) => {
      events.push(e)
    })
    await buildPassiveRecall('platypus', baseCfg, {
      wiki: fakeWiki([{ path: 'p', name: 'P', snippet: 's' }]),
      recall: fakeRecall([]),
      sessionId: 's1',
      eventBus: bus,
    })
    // Event emission is fire-and-forget — wait a tick for the handler.
    await new Promise((r) => setImmediate(r))
    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({
      type: 'recall.injected',
      sessionId: 's1',
      sources: [{ kind: 'wiki', ref: 'p', title: 'P' }],
    })
  })

  it('passes a keyword OR query (not the verbatim message) to wiki.search', async () => {
    let capturedQuery: string | null = null
    let capturedMode: string | undefined = undefined
    const wiki = {
      async search(query: string, opts?: { mode?: string }) {
        capturedQuery = query
        capturedMode = opts?.mode
        return []
      },
    } as unknown as WikiEngine
    await buildPassiveRecall(
      'What is the secret password for the passive-recall fixture? Quote it verbatim.',
      baseCfg,
      { wiki, recall: fakeRecall([]), sessionId: 's' },
    )
    expect(capturedQuery).not.toBeNull()
    // The verbatim message — as a phrase — would never match. The fix
    // is to send a disjunctive OR query over distinctive tokens, in raw mode.
    expect(capturedMode).toBe('raw')
    expect(capturedQuery).toContain(' OR ')
    expect(capturedQuery).toContain('passive-recall')
  })

  it('skips the wiki lane when the message has no extractable tokens', async () => {
    let wikiCalls = 0
    const wiki = {
      async search() {
        wikiCalls++
        return []
      },
    } as unknown as WikiEngine
    // All stopwords / too-short tokens.
    await buildPassiveRecall('the it of an a', baseCfg, {
      wiki,
      recall: fakeRecall([]),
      sessionId: 's',
    })
    expect(wikiCalls).toBe(0)
  })

  it('does not emit recall.injected when no sources match', async () => {
    const bus = new EventBus()
    const events: AgentEvent[] = []
    bus.on('recall.injected', (e) => {
      events.push(e)
    })
    await buildPassiveRecall('q', baseCfg, {
      wiki: fakeWiki([]),
      recall: fakeRecall([]),
      sessionId: 's',
      eventBus: bus,
    })
    await new Promise((r) => setImmediate(r))
    expect(events.length).toBe(0)
  })
})

describe('extractFtsQuery', () => {
  it('keeps distinctive multi-character tokens', () => {
    const q = extractFtsQuery('What is the platypus diet?')
    expect(q).not.toBeNull()
    expect(q!).toContain('platypus')
    // 'what', 'the' are stopwords; 'is' is too short — none should appear.
    expect(q!).not.toMatch(/\bwhat\b/i)
    expect(q!).not.toMatch(/\bthe\b/i)
  })

  it('uses OR between tokens', () => {
    const q = extractFtsQuery('marsupials echidna platypus')
    expect(q).toContain(' OR ')
  })

  it('quotes each token so FTS5 keywords cannot break out', () => {
    // "or" and "near" are FTS5 operators — quoted, they become literals.
    const q = extractFtsQuery('near platypus diet')
    expect(q).toBeTruthy()
    expect(q!).toMatch(/"near"|"platypus"|"diet"/)
  })

  it('returns null when the message is all stopwords', () => {
    expect(extractFtsQuery('the of and or is in to a')).toBeNull()
  })

  it('returns null when the message is all too-short tokens', () => {
    expect(extractFtsQuery('a b c d e f')).toBeNull()
  })

  it('strips FTS5-operator punctuation so it cannot escape token mode', () => {
    const q = extractFtsQuery('what is "platypus" * (curious)')
    // Should not contain unescaped quotes/parens/asterisks at the
    // expression level — only inside the quoted tokens we built.
    expect(q).toBeTruthy()
    // The query is of the form "tok1" OR "tok2" — no other quote pairs.
    expect(q!.match(/"/g)?.length).toBe((q!.split(' OR ').length) * 2)
  })

  it('caps token count', () => {
    const long = Array.from({ length: 20 }, (_, i) => `token${i}distinctive`).join(' ')
    const q = extractFtsQuery(long)
    // 6 token cap → 6 quoted strings → 12 quote characters
    expect(q!.split(' OR ').length).toBe(6)
  })

  it('deduplicates repeated tokens', () => {
    const q = extractFtsQuery('platypus platypus platypus')
    expect(q!.split(' OR ').length).toBe(1)
  })
})

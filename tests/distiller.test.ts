import { describe, it, expect } from 'vitest'
import {
  distill,
  parseDistillerResponse,
  renderDistilledMarkdown,
  type DistilledNote,
} from '@/skills/distiller.js'
import { FakeProvider } from './fakes.js'

describe('parseDistillerResponse', () => {
  it('parses a clean JSON array', () => {
    const raw = JSON.stringify([
      { kind: 'preference', title: 'TypeScript over JavaScript', body: 'User prefers TypeScript.' },
    ])
    const { notes, reparseUsed } = parseDistillerResponse(raw)
    expect(reparseUsed).toBe(false)
    expect(notes).toHaveLength(1)
    expect(notes[0].kind).toBe('preference')
  })

  it('strips ```json fences', () => {
    const raw = '```json\n[{"kind":"definition","title":"x","body":"y"}]\n```'
    const { notes, reparseUsed } = parseDistillerResponse(raw)
    expect(reparseUsed).toBe(true)
    expect(notes).toHaveLength(1)
  })

  it('strips bare ``` fences', () => {
    const raw = '```\n[{"kind":"project","title":"x","body":"y"}]\n```'
    const { notes } = parseDistillerResponse(raw)
    expect(notes).toHaveLength(1)
  })

  it('extracts array from leading prose', () => {
    const raw =
      'Here are the durable facts I extracted:\n[{"kind":"reference","title":"x","body":"y"}]\nLet me know if you want more.'
    const { notes, reparseUsed } = parseDistillerResponse(raw)
    expect(reparseUsed).toBe(true)
    expect(notes).toHaveLength(1)
  })

  it('promotes a single bare object into a one-element array', () => {
    const raw = JSON.stringify({ kind: 'decision', title: 'x', body: 'y' })
    const { notes } = parseDistillerResponse(raw)
    expect(notes).toHaveLength(1)
    expect(notes[0].kind).toBe('decision')
  })

  it('drops entries with invalid kinds', () => {
    const raw = JSON.stringify([
      { kind: 'preference', title: 'ok', body: 'fine' },
      { kind: 'nonsense', title: 'bad', body: 'bad' },
    ])
    const { notes } = parseDistillerResponse(raw)
    // Zod array fails the whole array if any element fails — that's the
    // contract. The fallback parser then tries fence-stripping; for raw
    // JSON with no wrappers the second attempt also fails, so notes = [].
    expect(notes).toEqual([])
  })

  it('returns empty for non-JSON gibberish', () => {
    const { notes } = parseDistillerResponse('I think there are no facts worth keeping.')
    expect(notes).toEqual([])
  })

  it('returns empty for empty string', () => {
    const { notes, reparseUsed } = parseDistillerResponse('')
    expect(notes).toEqual([])
    expect(reparseUsed).toBe(false)
  })

  it('rejects entries with missing required fields', () => {
    const raw = JSON.stringify([{ kind: 'preference', title: 'x' /* no body */ }])
    const { notes } = parseDistillerResponse(raw)
    expect(notes).toEqual([])
  })
})

describe('distill', () => {
  it('passes a system prompt + transcript to the provider', async () => {
    const provider = new FakeProvider({
      respond: () =>
        JSON.stringify([{ kind: 'preference', title: 'concise replies', body: 'User wants short answers.' }]),
    })
    const result = await distill(
      [
        { role: 'user', content: 'Be terse please.' },
        { role: 'assistant', content: 'Will do.' },
      ],
      provider,
      'fake-model',
    )
    expect(result.notes).toHaveLength(1)
    expect(provider.calls).toHaveLength(1)
    const req = provider.calls[0]
    expect(req.messages[0].role).toBe('system')
    expect(req.messages[1].role).toBe('user')
    expect(req.messages[1].content).toContain('Be terse please.')
    expect(req.messages[1].content).toContain('Will do.')
  })

  it('truncates transcripts that exceed maxTranscriptChars (keeps the tail)', async () => {
    const provider = new FakeProvider({ respond: () => '[]' })
    const huge = 'x'.repeat(50_000)
    await distill(
      [
        { role: 'user', content: huge },
        { role: 'assistant', content: 'TAIL_MARKER' },
      ],
      provider,
      'fake-model',
      { maxTranscriptChars: 5_000 },
    )
    const body = provider.calls[0].messages[1].content as string
    expect(body).toContain('TAIL_MARKER') // tail preserved
    expect(body.length).toBeLessThan(huge.length / 2) // truncated
    expect(body).toContain('earlier turns truncated')
  })

  it('returns empty notes (not throw) on unparseable model output', async () => {
    const provider = new FakeProvider({ respond: () => 'I cannot do that, Dave.' })
    const result = await distill(
      [{ role: 'user', content: 'distill this' }],
      provider,
      'fake-model',
    )
    expect(result.notes).toEqual([])
    expect(result.rawResponse).toContain('Dave')
  })

  it('skips empty-content turns when building the transcript', async () => {
    const provider = new FakeProvider({ respond: () => '[]' })
    await distill(
      [
        { role: 'user', content: 'real content' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: 'also real' },
      ],
      provider,
      'fake-model',
    )
    const body = provider.calls[0].messages[1].content as string
    // Two non-empty turns, joined with blank lines — three lines of content.
    expect(body).toContain('real content')
    expect(body).toContain('also real')
  })
})

describe('renderDistilledMarkdown', () => {
  const sample: DistilledNote[] = [
    { kind: 'preference', title: 'short replies', body: 'Wants concise summaries.' },
    { kind: 'project', title: 'storage root', body: 'On OneDrive.' },
    { kind: 'preference', title: 'no emoji', body: 'Avoid emoji.' },
  ]

  it('writes frontmatter and groups by kind in canonical order', () => {
    const md = renderDistilledMarkdown({
      sessionId: 'sess-1',
      sessionTitle: 'My session',
      notes: sample,
      generatedAt: new Date('2026-05-21T12:00:00Z'),
    })
    expect(md).toContain('source_session: sess-1')
    expect(md).toContain('status: draft')
    expect(md).toContain('## preference')
    expect(md).toContain('## project')
    // Same-kind notes are grouped under one heading.
    const preferenceCount = (md.match(/## preference/g) ?? []).length
    expect(preferenceCount).toBe(1)
    // 'preference' section comes before 'project' (canonical order in renderer).
    expect(md.indexOf('## preference')).toBeLessThan(md.indexOf('## project'))
  })

  it('omits empty sections', () => {
    const md = renderDistilledMarkdown({
      sessionId: 'sess-2',
      sessionTitle: null,
      notes: [{ kind: 'project', title: 'x', body: 'y' }],
      generatedAt: new Date('2026-05-21T12:00:00Z'),
    })
    expect(md).not.toContain('## preference')
    expect(md).not.toContain('## decision')
    expect(md).toContain('## project')
  })

  it('omits source_session_title when title is null', () => {
    const md = renderDistilledMarkdown({
      sessionId: 'sess-3',
      sessionTitle: null,
      notes: [],
      generatedAt: new Date(),
    })
    expect(md).not.toContain('source_session_title:')
  })
})

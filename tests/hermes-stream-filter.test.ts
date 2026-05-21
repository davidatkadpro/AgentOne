import { describe, it, expect } from 'vitest'
import { HermesStreamFilter } from '@/providers/hermes-stream-filter.js'

function feed(filter: HermesStreamFilter, deltas: string[]): { yielded: string; assembled: string } {
  let yielded = ''
  for (const d of deltas) yielded += filter.push(d)
  yielded += filter.flush()
  return { yielded, assembled: filter.assembled }
}

describe('HermesStreamFilter', () => {
  it('passes through content with no <tool_call> at all', () => {
    const f = new HermesStreamFilter()
    const r = feed(f, ['Hello, ', 'world.'])
    expect(r.yielded).toBe('Hello, world.')
    expect(r.assembled).toBe('Hello, world.')
  })

  it('suppresses a complete <tool_call>...</tool_call> block', () => {
    const f = new HermesStreamFilter()
    const r = feed(f, [
      "Sure, calling now.\n",
      '<tool_call><function=t><parameter=a>1</parameter></function></tool_call>',
      '\nDone.',
    ])
    expect(r.yielded).toBe('Sure, calling now.\n\nDone.')
    expect(r.assembled).toContain('<tool_call>')
  })

  it('suppresses a block split arbitrarily across deltas', () => {
    const f = new HermesStreamFilter()
    const r = feed(f, [
      'prefix ',
      '<too',
      'l_ca',
      'll><function=t><para',
      'meter=a>1</parameter></function></tool_call>',
      ' suffix',
    ])
    expect(r.yielded).toBe('prefix  suffix')
  })

  it('holds back a trailing partial open-tag prefix between deltas', () => {
    const f = new HermesStreamFilter()
    let out1 = f.push('content here <')
    // `<` could be the start of <tool_call>; yield only "content here "
    expect(out1).toBe('content here ')
    let out2 = f.push('not a tag, just text')
    // Now we know the `<` was benign; yield it plus the rest.
    expect(out2).toBe('<not a tag, just text')
    expect(f.flush()).toBe('')
  })

  it('does NOT hold back a `<` that is clearly not a tool_call prefix', () => {
    const f = new HermesStreamFilter()
    // "<x" is not a prefix of "<tool_call>" so it's safe to yield immediately.
    expect(f.push('a < b ? 1 : 2')).toBe('a < b ? 1 : 2')
  })

  it('flushes a never-completed partial open tag as benign content', () => {
    const f = new HermesStreamFilter()
    f.push('hello <to')
    // Stream ends mid-prefix; the bytes weren't part of a real open.
    expect(f.flush()).toBe('<to')
    expect(f.hadUnclosedBlock).toBe(false)
  })

  it('drops the buffered XML when an unclosed block reaches flush()', () => {
    const f = new HermesStreamFilter()
    f.push('start ')
    f.push('<tool_call><function=t><parameter=a>1</parameter>')
    // Model cut off before </tool_call>. Don't dribble the half-block out.
    expect(f.flush()).toBe('')
    expect(f.hadUnclosedBlock).toBe(true)
    expect(f.assembled).toContain('<tool_call>')
  })

  it('handles multiple complete blocks back-to-back in one stream', () => {
    const f = new HermesStreamFilter()
    const r = feed(f, [
      '<tool_call><function=a></function></tool_call>',
      'mid ',
      '<tool_call><function=b></function></tool_call>',
      'end',
    ])
    expect(r.yielded).toBe('mid end')
  })

  it('handles a single delta containing close+open of consecutive blocks', () => {
    const f = new HermesStreamFilter()
    const r = feed(f, [
      '<tool_call><function=a></function>',
      '</tool_call>middle<tool_call><function=b></function></tool_call>',
      'tail',
    ])
    expect(r.yielded).toBe('middletail')
  })

  it('preserves content that appears between the close tag and the next delta', () => {
    const f = new HermesStreamFilter()
    const r = feed(f, [
      '<tool_call><function=t></function></tool_call>after close',
    ])
    expect(r.yielded).toBe('after close')
  })

  it('exposes the full assembled buffer (including suppressed XML) for parsing', () => {
    const f = new HermesStreamFilter()
    feed(f, [
      'prefix ',
      '<tool_call><function=t><parameter=x>v</parameter></function></tool_call>',
      ' suffix',
    ])
    expect(f.assembled).toBe(
      'prefix <tool_call><function=t><parameter=x>v</parameter></function></tool_call> suffix',
    )
  })
})

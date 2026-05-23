import { describe, it, expect } from 'vitest'
import { parseSlashInput } from '@/lib/slash-parser'

describe('parseSlashInput', () => {
  it('parses a bare slash command', () => {
    expect(parseSlashInput('/help')).toEqual({ name: 'help', args: {}, text: '' })
  })

  it('parses key=value args', () => {
    expect(parseSlashInput('/skill name=experts/consult arg2=value')).toEqual({
      name: 'skill',
      args: { name: 'experts/consult', arg2: 'value' },
      text: '',
    })
  })

  it('handles quoted values with escaped quotes', () => {
    expect(parseSlashInput('/x msg="hello \\"world\\""')).toEqual({
      name: 'x',
      args: { msg: 'hello "world"' },
      text: '',
    })
  })

  it('keeps unparsed tokens in text', () => {
    expect(parseSlashInput('/forward this is the message')).toEqual({
      name: 'forward',
      args: {},
      text: 'this is the message',
    })
  })

  it('mixes args and trailing text', () => {
    expect(parseSlashInput('/skill name=x trailing text here')).toEqual({
      name: 'skill',
      args: { name: 'x' },
      text: 'trailing text here',
    })
  })

  it('tolerates leading whitespace', () => {
    expect(parseSlashInput('   /help')).toEqual({ name: 'help', args: {}, text: '' })
  })
})

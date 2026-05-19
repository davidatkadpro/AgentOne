import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain ES module, no .d.ts
import { parseSlashInput } from '../src/frontend/slash-parser.js'

describe('parseSlashInput', () => {
  it('bare command name', () => {
    expect(parseSlashInput('/help')).toEqual({ name: 'help', args: {}, text: '' })
  })

  it('command with single key=value', () => {
    expect(parseSlashInput('/sessions limit=50')).toEqual({
      name: 'sessions',
      args: { limit: '50' },
      text: '',
    })
  })

  it('quoted value with spaces', () => {
    expect(parseSlashInput('/new title="my first session"')).toEqual({
      name: 'new',
      args: { title: 'my first session' },
      text: '',
    })
  })

  it('escaped quotes inside a quoted value', () => {
    expect(parseSlashInput('/new title="he said \\"hi\\""')).toEqual({
      name: 'new',
      args: { title: 'he said "hi"' },
      text: '',
    })
  })

  it('hyphenated key name', () => {
    expect(parseSlashInput('/load skill-name=system/docs')).toEqual({
      name: 'load',
      args: { 'skill-name': 'system/docs' },
      text: '',
    })
  })

  it('positional tokens land in text', () => {
    expect(parseSlashInput('/dive deeper into quantum mechanics')).toEqual({
      name: 'dive',
      args: {},
      text: 'deeper into quantum mechanics',
    })
  })

  it('mixed key=value and trailing text', () => {
    expect(parseSlashInput('/dive depth=3 quantum mechanics')).toEqual({
      name: 'dive',
      args: { depth: '3' },
      text: 'quantum mechanics',
    })
  })

  it('leading slash and whitespace tolerated', () => {
    expect(parseSlashInput('   /help   ')).toEqual({ name: 'help', args: {}, text: '' })
  })

  it('multiple key=value pairs', () => {
    expect(parseSlashInput('/cmd a=1 b=two c="three four"')).toEqual({
      name: 'cmd',
      args: { a: '1', b: 'two', c: 'three four' },
      text: '',
    })
  })

  it('duplicate keys: last write wins', () => {
    expect(parseSlashInput('/cmd a=1 a=2')).toEqual({
      name: 'cmd',
      args: { a: '2' },
      text: '',
    })
  })
})

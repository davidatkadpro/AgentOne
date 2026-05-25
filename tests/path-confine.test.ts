import { describe, expect, it } from 'vitest'
import { isAbsolute, sep } from 'node:path'
import {
  confineToRoot,
  isSafeRelativePath,
} from '../src/storage/path-confine.js'

const root = process.platform === 'win32' ? 'C:\\repo\\storage' : '/var/storage'

describe('confineToRoot', () => {
  it('accepts a normal relative path', () => {
    const r = confineToRoot(root, 'projects/24001/file.txt')
    expect(r).not.toBeNull()
    expect(isAbsolute(r!)).toBe(true)
  })

  it('accepts the root itself when allowRoot defaults true', () => {
    expect(confineToRoot(root, '.')).not.toBeNull()
  })

  it('rejects root when allowRoot is false', () => {
    expect(confineToRoot(root, '.', { allowRoot: false })).toBeNull()
  })

  it('rejects absolute relative input', () => {
    expect(confineToRoot(root, process.platform === 'win32' ? 'C:\\evil' : '/evil')).toBeNull()
  })

  it('rejects a `..` traversal that escapes root', () => {
    expect(confineToRoot(root, '../sibling/file')).toBeNull()
    expect(confineToRoot(root, '../../etc/passwd')).toBeNull()
  })

  it('rejects a sibling-prefix attack — `storage` vs `storage2`', () => {
    // The historical prefix check would have accepted this on POSIX:
    // `/var/storage2/x` starts with `/var/storage`. The relative-based
    // check correctly rejects.
    expect(confineToRoot(root, '../storage2/x')).toBeNull()
  })

  it('rejects embedded NUL bytes', () => {
    expect(confineToRoot(root, 'projects/\0/file')).toBeNull()
  })

  it('accepts a path that traverses but lands back inside root', () => {
    // `projects/x/../y` resolves to `projects/y` which is still under root.
    const r = confineToRoot(root, 'projects/x/../y')
    expect(r).not.toBeNull()
  })
})

describe('isSafeRelativePath', () => {
  it.each([
    'projects/24001 - foo',
    'projects/24001/file.txt',
    'a/b/c',
    'single.txt',
  ])('accepts %s', (p) => {
    expect(isSafeRelativePath(p)).toBe(true)
  })

  it.each([
    '',
    '..',
    '../../etc/passwd',
    'projects/../../escape',
    'projects/./relative',
    'projects/file\0name',
    'projects\\windows-style',
    'C:\\evil',
    '/absolute/posix',
  ])('rejects %s', (p) => {
    expect(isSafeRelativePath(p)).toBe(false)
  })

  it('rejects drive-letter prefixes regardless of separator', () => {
    expect(isSafeRelativePath('D:foo')).toBe(false)
    expect(isSafeRelativePath('z:bar')).toBe(false)
  })

  // Cross-platform: separator probe. Verifies the function doesn't depend
  // on the running OS's sep — backslash always rejected, forward slash
  // always allowed.
  it('keeps semantics stable across platforms', () => {
    expect(isSafeRelativePath('a/b')).toBe(true)
    expect(isSafeRelativePath('a\\b')).toBe(false)
    void sep // sep is host-dependent; not used in the predicate.
  })
})

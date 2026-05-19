/**
 * Glob → RegExp for slash-separated paths.
 *  - `*`  matches a single path segment (no `/`)
 *  - `**` matches zero or more segments (consumes a trailing `/` if present)
 *  - all other characters are literal; regex metacharacters are escaped
 *
 * Used by the permission gate's `skills/*` patterns and the filesystem glob
 * tool's path filter.
 */
export function globToRegex(pattern: string): RegExp {
  let out = '^'
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 2
        if (pattern[i] === '/') i += 1
      } else {
        out += '[^/]*'
        i += 1
      }
      continue
    }
    if (ch !== undefined && /[.+?^${}()|[\]\\]/.test(ch)) out += '\\' + ch
    else if (ch !== undefined) out += ch
    i += 1
  }
  out += '$'
  return new RegExp(out)
}

export function globMatches(name: string, pattern: string): boolean {
  if (pattern === name) return true
  if (!pattern.includes('*')) return false
  return globToRegex(pattern).test(name)
}

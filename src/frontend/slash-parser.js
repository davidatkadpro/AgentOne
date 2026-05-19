/**
 * Tokenise `/name k=v k2="quoted v" trailing text` into { name, args, text }.
 * Key=value tokens are stripped from the trailing text. Keys may include
 * hyphens. Double-quoted values support \" escapes. Unmatched tokens stay in
 * `text` for skill-slash forwarding.
 *
 * Pure ES module, no DOM access — so unit-testable from Node.
 */
export function parseSlashInput(input) {
  const trimmed = String(input).trim().replace(/^\//, '').trim()
  const spaceIdx = trimmed.search(/\s/)
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()
  const args = {}
  const textTokens = []
  let i = 0
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i])) i++
    if (i >= rest.length) break
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_-]*)=/.exec(rest.slice(i))
    if (keyMatch) {
      const key = keyMatch[1]
      i += keyMatch[0].length
      let value
      if (rest[i] === '"') {
        i++
        let buf = ''
        while (i < rest.length && rest[i] !== '"') {
          if (rest[i] === '\\' && rest[i + 1] === '"') {
            buf += '"'
            i += 2
          } else {
            buf += rest[i]
            i++
          }
        }
        if (rest[i] === '"') i++
        value = buf
      } else {
        const start = i
        while (i < rest.length && !/\s/.test(rest[i])) i++
        value = rest.slice(start, i)
      }
      args[key] = value
    } else {
      const start = i
      while (i < rest.length && !/\s/.test(rest[i])) i++
      textTokens.push(rest.slice(start, i))
    }
  }
  return { name, args, text: textTokens.join(' ') }
}

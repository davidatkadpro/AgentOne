import { randomBytes } from 'node:crypto'

/**
 * In-memory OAuth state-token store with a 5-minute TTL. Single-process,
 * single-user trust model — there's no need for shared state across nodes.
 *
 * Each `mint()` returns an opaque token; the callback validates with
 * `consume()` which both checks existence and removes the token (one-shot).
 */
export interface OAuthStateStore {
  mint(): string
  consume(token: string): boolean
  size(): number
}

export interface OAuthStateOptions {
  ttlMs?: number
  /** Override Date.now (test-only). */
  now?: () => number
}

export function createOAuthStateStore(opts: OAuthStateOptions = {}): OAuthStateStore {
  const ttl = opts.ttlMs ?? 5 * 60_000
  const now = opts.now ?? Date.now
  const store = new Map<string, number>() // token -> expires-at

  function sweep(): void {
    const t = now()
    for (const [k, exp] of store.entries()) {
      if (exp <= t) store.delete(k)
    }
  }

  return {
    mint() {
      sweep()
      const token = randomBytes(24).toString('base64url')
      store.set(token, now() + ttl)
      return token
    },
    consume(token) {
      sweep()
      const exp = store.get(token)
      if (exp === undefined) return false
      store.delete(token)
      return exp > now()
    },
    size() {
      sweep()
      return store.size
    },
  }
}

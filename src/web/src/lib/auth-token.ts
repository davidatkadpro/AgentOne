/**
 * Bearer-token storage for the SPA. The server prints a token on first boot
 * (`AGENTONE_TOKEN=...`) and the operator presents it to the SPA in one of
 * two ways:
 *
 *   1. Visit `http://localhost:3737/#token=<value>` — `readTokenFromHash`
 *      strips the fragment, stores the token, then triggers a reload-free
 *      replaceState so the value doesn't linger in browser history.
 *   2. Paste it into a token-gate prompt rendered when `getAuthToken` is null.
 *
 * Token survives across reloads via localStorage. Use `clearAuthToken` on
 * 401 to force re-entry.
 */

const STORAGE_KEY = 'agentone:auth-token'

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setAuthToken(token: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, token)
  } catch {
    /* ignore — storage may be disabled in private mode */
  }
}

export function clearAuthToken(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * If the current URL has `#token=<value>` (or `?token=<value>`), consume it
 * into localStorage and rewrite the URL so the token doesn't appear in
 * browser history. Returns true if a token was harvested.
 */
export function readTokenFromHash(): boolean {
  if (typeof window === 'undefined') return false
  const { hash, search } = window.location
  const fromHash = parseTokenFromQueryLike(hash.startsWith('#') ? hash.slice(1) : hash)
  const fromSearch = fromHash ? null : parseTokenFromQueryLike(search.startsWith('?') ? search.slice(1) : search)
  const token = fromHash ?? fromSearch
  if (!token) return false
  setAuthToken(token)
  // Strip the token from the URL without reloading.
  const cleanHash = fromHash ? '' : window.location.hash
  const cleanSearch = fromSearch ? '' : window.location.search
  window.history.replaceState(
    null,
    '',
    window.location.pathname + cleanSearch + cleanHash,
  )
  return true
}

function parseTokenFromQueryLike(raw: string): string | null {
  if (!raw) return null
  const params = new URLSearchParams(raw)
  const t = params.get('token')
  return t && t.length > 0 ? t : null
}

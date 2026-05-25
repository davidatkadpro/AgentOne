/**
 * API + WebSocket authentication for the bundled HTTP server.
 *
 * AgentOne is local-trust by default, but the bundled skills include shell
 * and filesystem execution — anyone who can drive a turn can drive the
 * machine. This module enforces a single shared bearer token on every
 * `/api/*` request and every `/ws` upgrade so a misconfigured firewall,
 * stray tunnel, or compromised browser context cannot pilot the agent.
 *
 * Token lifecycle:
 *   - Persisted at `<storageRoot>/.auth/token` (file mode 0600 on POSIX).
 *   - Generated on first boot via `randomBytes(32).toString('base64url')`.
 *   - Printed to stdout on first boot AND on every boot via a short note,
 *     so an operator who lost theirs can recover it.
 *
 * Tests bypass auth by passing `{ enabled: false }` to `installAuthGate`.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export interface AuthOptions {
  /** When false (default in tests), installAuthGate is a no-op. */
  enabled: boolean
  /** Shared secret. Compared in constant time against the presented bearer. */
  token: string
  /**
   * Browsers that send an `Origin` header must match one of these. Wildcard
   * `*` disables the check (not recommended). Defaults set by the caller
   * usually include `http://127.0.0.1:<port>` and `http://localhost:<port>`.
   */
  allowedOrigins: string[]
}

/**
 * Read the persisted token at `<storageRoot>/.auth/token`, or generate one
 * and persist it on first call. The returned token is the value all clients
 * must present. Caller is expected to log it on first boot.
 */
export async function ensureAuthToken(storageRoot: string): Promise<{
  token: string
  created: boolean
  path: string
}> {
  const dir = join(storageRoot, '.auth')
  const path = join(dir, 'token')
  try {
    const existing = (await readFile(path, 'utf-8')).trim()
    if (existing.length >= 16) {
      return { token: existing, created: false, path }
    }
  } catch {
    // Fall through to creation.
  }
  await mkdir(dir, { recursive: true })
  const token = randomBytes(32).toString('base64url')
  await writeFile(path, token + '\n', 'utf-8')
  // POSIX: tighten perms. chmod is a no-op on Windows but harmless.
  try {
    await chmod(path, 0o600)
  } catch {
    // ignore — best effort
  }
  return { token, created: true, path }
}

/**
 * Constant-time comparison that tolerates length mismatch. The naive
 * `timingSafeEqual` throws on length mismatch which itself leaks a bit; we
 * normalise by always comparing equal-length buffers.
 */
function tokensMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  if (a.length !== b.length) {
    // Run timingSafeEqual against the same buffer to keep timing uniform.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (m) return m[1] ?? null
  }
  // WebSocket upgrades cannot set custom headers from browser code, so we
  // also accept `?token=` on the WS handshake. Same string is presented.
  const query = req.query as Record<string, unknown> | undefined
  if (query && typeof query.token === 'string') return query.token
  return null
}

function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true // non-browser caller; bearer alone gates
  if (allowed.includes('*')) return true
  return allowed.includes(origin)
}

const STATIC_PREFIXES = ['/assets/', '/favicon']
const STATIC_PATHS = new Set(['/', '/index.html'])

function isGatedPath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url
  if (path.startsWith('/api/')) return true
  if (path === '/ws' || path.startsWith('/ws/')) return true
  return false
}

function isStaticPath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url
  if (STATIC_PATHS.has(path)) return true
  return STATIC_PREFIXES.some((p) => path.startsWith(p))
}

/**
 * Install the auth pre-handler. Idempotent — calling more than once is a
 * programming error (Fastify lets you, but we'd run the check twice).
 *
 * Response shape on denial:
 *   401 { error: 'UNAUTHORIZED', reason: 'missing_token' | 'bad_token' }
 *   403 { error: 'FORBIDDEN', reason: 'bad_origin' }
 */
export function installAuthGate(app: FastifyInstance, opts: AuthOptions): void {
  if (!opts.enabled) return

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url
    if (!isGatedPath(url)) {
      // Static SPA assets pass through unauthenticated so the shell can
      // load and the user can paste the token. Anything else not in the
      // gated list also passes (e.g. `/`) — those endpoints either serve
      // public content or 404.
      if (!isStaticPath(url) && !url.startsWith('/api')) return
      return
    }

    if (!originAllowed(req.headers.origin, opts.allowedOrigins)) {
      return denyOrigin(reply)
    }

    const presented = extractBearer(req)
    if (!presented) {
      return denyMissing(reply)
    }
    if (!tokensMatch(opts.token, presented)) {
      return denyBad(reply)
    }
    // OK — fall through to route handler.
  })
}

function denyMissing(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: 'UNAUTHORIZED', reason: 'missing_token' })
}

function denyBad(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: 'UNAUTHORIZED', reason: 'bad_token' })
}

function denyOrigin(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: 'FORBIDDEN', reason: 'bad_origin' })
}

/**
 * Compute the default allowed-origin list for a given bind host/port. When
 * bound to a non-loopback host we keep the loopback aliases in the list —
 * operators frequently dev with the SPA hitting 127.0.0.1 while the server
 * announces the LAN IP separately.
 */
export function defaultAllowedOrigins(host: string, port: number): string[] {
  const set = new Set<string>([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ])
  if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '0.0.0.0') {
    set.add(`http://${host}:${port}`)
  }
  return [...set]
}

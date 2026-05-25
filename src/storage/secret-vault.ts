import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

/**
 * Encrypt/decrypt small secrets (OAuth tokens) at rest.
 *
 * Two backends:
 *   - **Windows** (`process.platform === 'win32'`): DPAPI via the lazy-loaded
 *     `win-dpapi` binding (or a fallback chain through `node-windows-dpapi`).
 *     When no binding is installed, falls back to AES-GCM with a key derived
 *     from `QBO_TOKEN_KEY` if set — otherwise refuses to encrypt.
 *   - **Non-Windows**: AES-GCM. Operator MUST set `QBO_TOKEN_KEY` env var to a
 *     hex or base64 32-byte key (or any-length string that we SHA-256 down).
 *     Without the env var, `createSecretVault()` throws at boot.
 *
 * The returned Buffer format is `version(1) | nonce(12) | tag(16) | ciphertext(*)`.
 */
export interface SecretVault {
  encrypt(plaintext: string): Buffer
  decrypt(buf: Buffer): string
  /** Reports which backend is in use — surfaced in the connection status UI
   *  so operators know whether the binding loaded. */
  backend: 'dpapi' | 'aes-gcm'
}

export interface SecretVaultOptions {
  /** Override platform detection (test-only). */
  platform?: NodeJS.Platform
  /** Override env (test-only). */
  env?: NodeJS.ProcessEnv
  /** Force a specific backend, ignoring platform (test-only). */
  forceBackend?: 'dpapi' | 'aes-gcm'
  /** Pre-resolved DPAPI binding (test-only). The shape mirrors `win-dpapi`. */
  dpapiBinding?: {
    protectData(plaintext: Buffer, entropy: Buffer | null, scope: 'CurrentUser' | 'LocalMachine'): Buffer
    unprotectData(ciphertext: Buffer, entropy: Buffer | null, scope: 'CurrentUser' | 'LocalMachine'): Buffer
  }
  /** Custom CommonJS-style require used by the DPAPI loader (test-only).
   *  Defaults to `createRequire(import.meta.url)`. Lets tests exercise the
   *  real loader code path without installing a native binding on disk. */
  requireFn?: (id: string) => unknown
}

const VERSION_BYTE = 0x01

function deriveKey(rawKey: string): Buffer {
  // Accept any-length key string. Hash to 32 bytes for AES-256-GCM.
  return createHash('sha256').update(rawKey, 'utf-8').digest()
}

function tryLoadDpapi(
  requireFn?: (id: string) => unknown,
): SecretVaultOptions['dpapiBinding'] | null {
  // win-dpapi is an optional native dep. We don't require it at the top of
  // the file so the bundle doesn't blow up on non-Windows hosts.
  //
  // We're an ES module (`"type": "module"`), so the bare `require` global is
  // undefined here. Use `createRequire(import.meta.url)` to get a CommonJS
  // require that can resolve installed packages from this file's location.
  // The historical `require('win-dpapi')` form silently threw ReferenceError
  // and made the binding effectively unreachable.
  try {
    const req = requireFn ?? createRequire(import.meta.url)
    const mod = req('win-dpapi') as SecretVaultOptions['dpapiBinding']
    if (mod && typeof mod.protectData === 'function' && typeof mod.unprotectData === 'function') {
      return mod
    }
  } catch {
    // No binding — we'll fall through to AES-GCM if QBO_TOKEN_KEY is set.
  }
  return null
}

export function createSecretVault(opts: SecretVaultOptions = {}): SecretVault {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const force = opts.forceBackend
  const useDpapi = force ? force === 'dpapi' : platform === 'win32'

  if (useDpapi) {
    const binding = opts.dpapiBinding ?? tryLoadDpapi(opts.requireFn)
    if (binding) {
      return {
        backend: 'dpapi',
        encrypt(plaintext) {
          const buf = Buffer.from(plaintext, 'utf-8')
          const protectedBuf = binding.protectData(buf, null, 'CurrentUser')
          // Prefix with version byte so we can change format later.
          return Buffer.concat([Buffer.from([VERSION_BYTE | 0x80]), protectedBuf])
        },
        decrypt(buf) {
          if (buf.length < 1) throw new Error('SecretVault: empty buffer')
          const v = buf[0]
          if (v === undefined || (v & 0x80) === 0) {
            throw new Error('SecretVault: buffer was not DPAPI-encrypted')
          }
          const raw = buf.subarray(1)
          const out = binding.unprotectData(raw, null, 'CurrentUser')
          return out.toString('utf-8')
        },
      }
    }
    // No binding: fall through to AES-GCM if a key is set. We don't throw
    // because some Windows dev installs won't ship the native binding; the
    // operator can still set QBO_TOKEN_KEY to keep tokens encrypted.
  }

  const keyRaw = env.QBO_TOKEN_KEY
  if (!keyRaw || keyRaw.length === 0) {
    throw new Error(
      'SecretVault: QBO_TOKEN_KEY env var is required when DPAPI is unavailable. ' +
        'Set QBO_TOKEN_KEY to any non-empty string (it will be hashed to a 32-byte key).',
    )
  }
  const key = deriveKey(keyRaw)
  return {
    backend: 'aes-gcm',
    encrypt(plaintext) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([Buffer.from([VERSION_BYTE]), nonce, tag, ct])
    },
    decrypt(buf) {
      if (buf.length < 1 + 12 + 16) throw new Error('SecretVault: ciphertext too short')
      const v = buf[0]
      if (v !== VERSION_BYTE) {
        throw new Error(`SecretVault: unexpected version byte ${v}`)
      }
      const nonce = buf.subarray(1, 13)
      const tag = buf.subarray(13, 29)
      const ct = buf.subarray(29)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      const pt = Buffer.concat([decipher.update(ct), decipher.final()])
      return pt.toString('utf-8')
    },
  }
}

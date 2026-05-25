import { describe, it, expect } from 'vitest'
import { createSecretVault } from '@/storage/secret-vault.js'

describe('secret-vault — AES-GCM backend', () => {
  it('round-trips a token through encrypt + decrypt', () => {
    const vault = createSecretVault({
      forceBackend: 'aes-gcm',
      env: { QBO_TOKEN_KEY: 'test-key-deterministic' } as NodeJS.ProcessEnv,
    })
    expect(vault.backend).toBe('aes-gcm')
    const cipher = vault.encrypt('hello-token')
    expect(cipher).toBeInstanceOf(Buffer)
    expect(cipher.toString('utf-8')).not.toContain('hello-token')
    expect(vault.decrypt(cipher)).toBe('hello-token')
  })

  it('different vault keys produce non-interoperable ciphertext', () => {
    const a = createSecretVault({
      forceBackend: 'aes-gcm',
      env: { QBO_TOKEN_KEY: 'key-a' } as NodeJS.ProcessEnv,
    })
    const b = createSecretVault({
      forceBackend: 'aes-gcm',
      env: { QBO_TOKEN_KEY: 'key-b' } as NodeJS.ProcessEnv,
    })
    const cipher = a.encrypt('secret')
    expect(() => b.decrypt(cipher)).toThrow()
  })

  it('throws if no QBO_TOKEN_KEY is set on non-Windows', () => {
    expect(() =>
      createSecretVault({
        platform: 'linux',
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toThrow(/QBO_TOKEN_KEY/)
  })

  it('rejects buffers with tampered tags', () => {
    const vault = createSecretVault({
      forceBackend: 'aes-gcm',
      env: { QBO_TOKEN_KEY: 'tamper-key' } as NodeJS.ProcessEnv,
    })
    const cipher = vault.encrypt('safe')
    // Flip a bit in the auth tag (offset 13–28).
    cipher[15] = (cipher[15] ?? 0) ^ 0xff
    expect(() => vault.decrypt(cipher)).toThrow()
  })

  it('uses a stubbed DPAPI binding when forced', () => {
    const fake = {
      protectData: (buf: Buffer) => Buffer.concat([Buffer.from('DPAPI:'), buf]),
      unprotectData: (buf: Buffer) => buf.subarray('DPAPI:'.length),
    }
    const vault = createSecretVault({ forceBackend: 'dpapi', dpapiBinding: fake })
    expect(vault.backend).toBe('dpapi')
    const cipher = vault.encrypt('windows-token')
    expect(vault.decrypt(cipher)).toBe('windows-token')
  })
})

describe('secret-vault — DPAPI loader path (ESM via createRequire)', () => {
  // These tests exercise the loader code path. The historical bug was that
  // `require('win-dpapi')` was invoked as a bare identifier inside an ES
  // module, where `require` is undefined and the resulting ReferenceError
  // was silently swallowed. The fix uses `createRequire(import.meta.url)`.
  // The injectable `requireFn` lets us prove the real loader code path
  // works without installing the optional native binding on disk.

  it('platform=win32: loads a binding via the injected require', () => {
    const fakeBinding = {
      protectData: (buf: Buffer) => Buffer.concat([Buffer.from('WIN:'), buf]),
      unprotectData: (buf: Buffer) => buf.subarray('WIN:'.length),
    }
    let resolved: string | null = null
    const requireFn = (id: string) => {
      resolved = id
      return fakeBinding
    }
    const vault = createSecretVault({
      platform: 'win32',
      requireFn,
      env: {} as NodeJS.ProcessEnv,
    })
    expect(resolved).toBe('win-dpapi')
    expect(vault.backend).toBe('dpapi')
    expect(vault.decrypt(vault.encrypt('hello'))).toBe('hello')
  })

  it('platform=win32: MODULE_NOT_FOUND falls back to AES-GCM when QBO_TOKEN_KEY is set', () => {
    const requireFn = (id: string) => {
      const err = new Error(`Cannot find module '${id}'`) as Error & { code?: string }
      err.code = 'MODULE_NOT_FOUND'
      throw err
    }
    const vault = createSecretVault({
      platform: 'win32',
      requireFn,
      env: { QBO_TOKEN_KEY: 'fallback-key' } as NodeJS.ProcessEnv,
    })
    expect(vault.backend).toBe('aes-gcm')
  })

  it('platform=win32: MODULE_NOT_FOUND with no fallback key throws on construction', () => {
    const requireFn = () => {
      const err = new Error('not installed') as Error & { code?: string }
      err.code = 'MODULE_NOT_FOUND'
      throw err
    }
    expect(() =>
      createSecretVault({
        platform: 'win32',
        requireFn,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toThrow(/QBO_TOKEN_KEY/)
  })

  it('platform=win32: a binding missing required functions falls through', () => {
    const requireFn = () => ({ notTheRightShape: true })
    const vault = createSecretVault({
      platform: 'win32',
      requireFn,
      env: { QBO_TOKEN_KEY: 'fallback-key' } as NodeJS.ProcessEnv,
    })
    expect(vault.backend).toBe('aes-gcm')
  })

  it('platform=linux: never tries to load the DPAPI binding', () => {
    let called = false
    const requireFn = () => {
      called = true
      throw new Error('should not be called')
    }
    const vault = createSecretVault({
      platform: 'linux',
      requireFn,
      env: { QBO_TOKEN_KEY: 'linux-key' } as NodeJS.ProcessEnv,
    })
    expect(called).toBe(false)
    expect(vault.backend).toBe('aes-gcm')
  })
})

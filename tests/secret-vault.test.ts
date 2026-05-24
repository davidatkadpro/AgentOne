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

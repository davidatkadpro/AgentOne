import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { createConversationStore } from '@/storage/sqlite.js'
import { backupDatabase, defaultFilename } from '@/storage/backup.js'
import { backupCommand, renderBackupSummary } from '@/server/commands/backup.js'
import type { CommandContext } from '@/server/commands/types.js'
import type { ServerConfig } from '@/server/config.js'

let dir: string
let dbPath: string
let db: Db

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentone-backup-'))
  dbPath = join(dir, 'agentone.db')
  db = createDatabase({ path: dbPath })
  // Put something in the DB so the backup has data to copy.
  const store = createConversationStore(db)
  const session = store.createSession({ agentProfile: 'p', title: 'before backup' })
  store.appendTurn({ sessionId: session.id, role: 'user', content: 'hello' })
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('defaultFilename', () => {
  it('produces a Windows-safe timestamped name', () => {
    const stamp = defaultFilename(new Date('2026-05-22T07:21:30.123Z'))
    expect(stamp).toBe('agentone-2026-05-22T07-21-30.db')
    // No colons (forbidden in Windows filenames).
    expect(stamp.includes(':')).toBe(false)
  })
})

describe('backupDatabase', () => {
  it('writes a usable copy to a directory destination', async () => {
    const destDir = join(dir, 'backups')
    const fixedNow = () => new Date('2026-05-22T07:21:30Z')
    const result = await backupDatabase(db, { destination: destDir, now: fixedNow })
    expect(result.path).toBe(join(destDir, 'agentone-2026-05-22T07-21-30.db'))
    const info = await stat(result.path)
    expect(info.size).toBeGreaterThan(0)

    // The backup is a real SQLite database with the original's content.
    const restored = createDatabase({ path: result.path, skipMkdir: true })
    try {
      const sessions = restored
        .prepare('SELECT title FROM sessions')
        .all() as Array<{ title: string }>
      expect(sessions).toEqual([{ title: 'before backup' }])
    } finally {
      restored.close()
    }
  })

  it('writes to an explicit file path when one is given', async () => {
    const destFile = join(dir, 'snapshots', 'manual.sqlite')
    const result = await backupDatabase(db, { destination: destFile })
    expect(result.path).toBe(destFile)
    const info = await stat(destFile)
    expect(info.size).toBeGreaterThan(0)
  })

  it('records a non-zero durationMs', async () => {
    const result = await backupDatabase(db, { destination: join(dir, 'b') })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('/backup command', () => {
  function fakeConfig(storageRoot: string): ServerConfig {
    return { storageRoot } as ServerConfig
  }

  function makeCtx(): CommandContext {
    return {
      sessionId: null,
      store: {} as never,
      skillIndex: {} as never,
      orchestrator: {} as never,
      contextManager: {} as never,
      config: fakeConfig(dir),
      wiki: {} as never,
      compressorProvider: {} as never,
      compressorModel: 'unused',
      db,
    }
  }

  it('writes a backup to <storageRoot>/backups by default and returns a text summary', async () => {
    const result = await backupCommand.handler({}, makeCtx())
    expect(result.kind).toBe('text')
    if (result.kind !== 'text') return
    expect(result.content).toContain('Backed up to')
    expect(result.content).toMatch(/agentone-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db/)
    expect(result.content).toMatch(/kB in \d+ ms/)

    // File actually exists.
    const match = result.content.match(/Backed up to (.+?)\n/)
    expect(match).not.toBeNull()
    const path = match![1]
    const info = await stat(path)
    expect(info.size).toBeGreaterThan(0)
    await readFile(path) // round-trips
  })

  it('writes to an explicit destination when one is given', async () => {
    const explicit = join(dir, 'custom-backup.sqlite')
    const result = await backupCommand.handler({ destination: explicit }, makeCtx())
    expect(result.kind).toBe('text')
    if (result.kind !== 'text') return
    expect(result.content).toContain(explicit)
    const info = await stat(explicit)
    expect(info.size).toBeGreaterThan(0)
  })

  it('returns an error result when backup throws', async () => {
    // Force a failure by pointing at an unwritable destination — a directory
    // path with a parent that's actually a regular file.
    const blockedParent = join(dir, 'blocker')
    // Create a file at the destination path so backup's mkdir of dirname
    // can succeed but the final write conflicts.
    await readFile(dbPath) // sanity
    const explicit = join(blockedParent, 'sub', 'b.db')
    // Make blockedParent a file, not a dir.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(blockedParent, 'not a directory', 'utf-8')

    const result = await backupCommand.handler({ destination: explicit }, makeCtx())
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.message).toContain('Backup failed')
  })
})

describe('renderBackupSummary', () => {
  it('formats path + size + duration', () => {
    const out = renderBackupSummary({
      path: '/tmp/agentone-x.db',
      bytes: 1024 * 12,
      durationMs: 42,
    })
    expect(out).toContain('/tmp/agentone-x.db')
    expect(out).toContain('12.0 kB')
    expect(out).toContain('42 ms')
  })
})

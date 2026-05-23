import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabase, type Db } from '@/storage/db.js'
import { applyModuleMigrations } from '@/modules/migrations.js'
import { createAuditLog } from '@/modules/audit-log.js'
import { EventBus } from '@/core/events.js'
import type { StorageAdapter, StorageReadResult, StorageWriteResult, StorageListEntry } from '@/storage/adapter.js'
import {
  createProjectsService,
  type ProjectsService,
} from '../modules/projects/src/service.js'

class RecordingStorage implements StorageAdapter {
  readonly ensureDirCalls: string[] = []
  readonly writeCalls: Array<{ path: string; content: string | Buffer }> = []

  async ensureDir(path: string): Promise<void> {
    this.ensureDirCalls.push(path)
  }
  async read(_path: string): Promise<StorageReadResult> {
    throw new Error('not implemented')
  }
  async readText(_path: string): Promise<string> {
    throw new Error('not implemented')
  }
  async write(path: string, content: Buffer | string): Promise<StorageWriteResult> {
    this.writeCalls.push({ path, content })
    return { size: 0, mtime: new Date() }
  }
  async exists(_path: string): Promise<boolean> {
    return false
  }
  async delete(_path: string): Promise<void> {
    // no-op
  }
  // eslint-disable-next-line require-yield
  async *list(_prefix?: string): AsyncIterable<StorageListEntry> {
    return
  }
}

interface Harness {
  db: Db
  storage: RecordingStorage
  service: ProjectsService
}

function newHarness(): Harness {
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const sql = readFileSync(
    join(process.cwd(), 'modules', 'projects', 'schema', '001_init.sql'),
    'utf-8',
  )
  applyModuleMigrations(db, 'projects', [{ version: 1, name: '001_init', sql }])
  const storage = new RecordingStorage()
  const service = createProjectsService({
    db,
    eventBus: new EventBus(),
    audit: createAuditLog(db),
    storage,
  })
  return { db, storage, service }
}

describe('ProjectsService.createProject — folder creation', () => {
  let h: Harness
  beforeEach(() => {
    h = newHarness()
  })
  afterEach(() => {
    h.db.close()
  })

  it('creates projects/<number> - <name>/ and the in/ + drafts/ subfolders', async () => {
    const project = h.service.createProject(
      { number: '24001', name: 'Riverside Reno' },
      { actor: { type: 'user' } },
    )
    // Allow the async ensureDir microtasks to flush.
    await new Promise((r) => setImmediate(r))

    expect(project.folderPath).toBe('projects/24001 - Riverside Reno')
    expect(h.storage.ensureDirCalls).toEqual([
      'projects/24001 - Riverside Reno',
      'projects/24001 - Riverside Reno/in',
      'projects/24001 - Riverside Reno/drafts',
    ])
  })

  it('sanitizes name characters that are illegal on Windows filesystems', async () => {
    const project = h.service.createProject(
      { number: '24002', name: 'A/B: <C> | "D" * ? \\E' },
      { actor: { type: 'user' } },
    )
    await new Promise((r) => setImmediate(r))

    const slugPart = project.folderPath?.replace(/^projects\/24002 - /, '') ?? ''
    expect(slugPart).not.toMatch(/[<>:"\\|?*/]/)
    expect(slugPart.length).toBeGreaterThan(0)
    expect(h.storage.ensureDirCalls[0]).toBe(project.folderPath)
  })

  it('honors an explicit folderPath input override', async () => {
    const project = h.service.createProject(
      { number: '24003', name: 'X', folderPath: 'projects/custom/path' },
      { actor: { type: 'user' } },
    )
    await new Promise((r) => setImmediate(r))

    expect(project.folderPath).toBe('projects/custom/path')
    expect(h.storage.ensureDirCalls[0]).toBe('projects/custom/path')
  })
})

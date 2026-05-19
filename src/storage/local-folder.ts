import { mkdir, readFile, writeFile, stat, unlink, readdir } from 'node:fs/promises'
import { join, dirname, isAbsolute, posix, relative, sep } from 'node:path'
import {
  StorageError,
  type StorageAdapter,
  type StorageListEntry,
  type StorageReadResult,
  type StorageWriteResult,
} from './adapter.js'

export interface LocalFolderAdapterConfig {
  /** Absolute path to the root directory. */
  root: string
}

export class LocalFolderAdapter implements StorageAdapter {
  constructor(private readonly cfg: LocalFolderAdapterConfig) {
    if (!isAbsolute(cfg.root)) {
      throw new StorageError(`Root must be an absolute path: ${cfg.root}`, 'INVALID_PATH')
    }
  }

  async read(path: string): Promise<StorageReadResult> {
    const abs = this.resolve(path)
    try {
      const [content, s] = await Promise.all([readFile(abs), stat(abs)])
      return { content, mtime: s.mtime, size: s.size }
    } catch (err) {
      if (isNotFound(err)) throw new StorageError(`Not found: ${path}`, 'NOT_FOUND', err)
      throw new StorageError(`Read failed: ${path}`, 'IO', err)
    }
  }

  async readText(path: string): Promise<string> {
    return (await this.read(path)).content.toString('utf-8')
  }

  async write(path: string, content: Buffer | string): Promise<StorageWriteResult> {
    const abs = this.resolve(path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
    const s = await stat(abs)
    return { size: s.size, mtime: s.mtime }
  }

  async exists(path: string): Promise<boolean> {
    const abs = this.resolve(path)
    try {
      await stat(abs)
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw new StorageError(`Exists check failed: ${path}`, 'IO', err)
    }
  }

  async delete(path: string): Promise<void> {
    const abs = this.resolve(path)
    try {
      await unlink(abs)
    } catch (err) {
      if (isNotFound(err)) return
      throw new StorageError(`Delete failed: ${path}`, 'IO', err)
    }
  }

  async *list(prefix?: string): AsyncIterable<StorageListEntry> {
    const startAbs = prefix ? this.resolve(prefix) : this.cfg.root
    let entries
    try {
      entries = await readdir(startAbs, { recursive: true, withFileTypes: true })
    } catch (err) {
      if (isNotFound(err)) return
      throw new StorageError(`List failed: ${startAbs}`, 'IO', err)
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const childAbs = join(entry.parentPath ?? startAbs, entry.name)
      const s = await stat(childAbs)
      yield {
        path: this.relativize(childAbs),
        size: s.size,
        mtime: s.mtime,
      }
    }
  }

  /**
   * Map a caller path (POSIX, relative) into an absolute path under root.
   * Rejects absolute paths and anything that, after normalisation, would
   * escape root. This is the security boundary for the adapter.
   */
  private resolve(path: string): string {
    if (!path || path === '.' || path === '/') {
      throw new StorageError(`Invalid path: ${path}`, 'INVALID_PATH')
    }
    if (isAbsolute(path)) {
      throw new StorageError(`Absolute paths not allowed: ${path}`, 'INVALID_PATH')
    }
    const normalized = posix.normalize(path.replace(/\\/g, '/'))
    if (normalized.startsWith('..')) {
      throw new StorageError(`Path traversal blocked: ${path}`, 'INVALID_PATH')
    }
    return join(this.cfg.root, normalized)
  }

  private relativize(abs: string): string {
    return relative(this.cfg.root, abs).split(sep).join('/')
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT'
}

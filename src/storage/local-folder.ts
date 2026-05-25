import { mkdir, readFile, writeFile, stat, unlink, readdir, open } from 'node:fs/promises'
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

  async ensureDir(path: string): Promise<void> {
    const abs = this.resolve(path)
    try {
      await mkdir(abs, { recursive: true })
    } catch (err) {
      throw new StorageError(`ensureDir failed: ${path}`, 'IO', err)
    }
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

  async stat(path: string): Promise<StorageListEntry> {
    const abs = this.resolve(path)
    try {
      const s = await stat(abs)
      return { path, size: s.size, mtime: s.mtime }
    } catch (err) {
      if (isNotFound(err)) throw new StorageError(`Not found: ${path}`, 'NOT_FOUND', err)
      throw new StorageError(`Stat failed: ${path}`, 'IO', err)
    }
  }

  /**
   * Read a contiguous byte range. Uses a positioned read so a multi-GB
   * file doesn't get buffered just to slice off a small head/tail.
   */
  async readRange(
    path: string,
    end: number,
    start = 0,
  ): Promise<StorageReadResult> {
    if (end < start) {
      throw new StorageError(
        `readRange: end (${end}) must be >= start (${start})`,
        'INVALID_PATH',
      )
    }
    const abs = this.resolve(path)
    const length = end - start + 1
    const buf = Buffer.alloc(length)
    let fh
    try {
      fh = await open(abs, 'r')
      const { bytesRead } = await fh.read(buf, 0, length, start)
      const s = await fh.stat()
      return {
        content: buf.subarray(0, bytesRead),
        size: s.size,
        mtime: s.mtime,
      }
    } catch (err) {
      if (isNotFound(err)) throw new StorageError(`Not found: ${path}`, 'NOT_FOUND', err)
      throw new StorageError(`readRange failed: ${path}`, 'IO', err)
    } finally {
      await fh?.close()
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

  /**
   * Walks the tree iteratively (BFS) and yields entries one at a time, so
   * an async consumer's `break` short-circuits the traversal mid-walk.
   * The historical implementation called `readdir(..., recursive: true)`,
   * which buffered the entire descendant list before yielding the first
   * entry — fine for small trees, very expensive (and slow to first byte)
   * on a 10k+ entry storage root.
   */
  async *list(prefix?: string): AsyncIterable<StorageListEntry> {
    const startAbs = prefix ? this.resolve(prefix) : this.cfg.root
    const queue: string[] = [startAbs]
    while (queue.length > 0) {
      const dir = queue.shift()!
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (isNotFound(err)) {
          if (dir === startAbs) return
          continue
        }
        throw new StorageError(`List failed: ${dir}`, 'IO', err)
      }
      for (const entry of entries) {
        const childAbs = join(dir, entry.name)
        if (entry.isDirectory()) {
          queue.push(childAbs)
          continue
        }
        if (!entry.isFile()) continue
        const s = await stat(childAbs)
        yield {
          path: this.relativize(childAbs),
          size: s.size,
          mtime: s.mtime,
        }
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

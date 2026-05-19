export interface StorageReadResult {
  content: Buffer
  mtime: Date
  size: number
}

export interface StorageWriteResult {
  mtime: Date
  size: number
}

export interface StorageListEntry {
  path: string
  size: number
  mtime: Date
}

export type StorageErrorCode = 'NOT_FOUND' | 'INVALID_PATH' | 'PRECONDITION' | 'IO'

/**
 * Abstraction over the file backend that holds the Wiki, project Documents, and
 * Drafts trees. The two production-grade choices are pointing at a OneDrive
 * sync mount (the operator's local mirror of SharePoint) and pointing at any
 * local folder (dev / offline). Both share the same filesystem-backed
 * implementation; a future Graph adapter would be a different class.
 *
 * All paths are forward-slash POSIX, relative to the adapter's root. The
 * adapter rejects traversal attempts ("..", absolute paths).
 */
export interface StorageAdapter {
  read(path: string): Promise<StorageReadResult>
  readText(path: string): Promise<string>
  write(path: string, content: Buffer | string): Promise<StorageWriteResult>
  exists(path: string): Promise<boolean>
  delete(path: string): Promise<void>
  list(prefix?: string): AsyncIterable<StorageListEntry>
  /** Optional. Returns an unsubscribe function. */
  watch?(prefix: string, onChange: (path: string) => void): () => void
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: StorageErrorCode,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'StorageError'
  }
}

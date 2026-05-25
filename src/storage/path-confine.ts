/**
 * Path-confinement helper shared by routes that build filesystem paths from
 * user-controlled input (e.g. project folder paths, proposal asset paths).
 *
 * Prior code used `joined.startsWith(normalizedRoot)`. That fails for sibling
 * directories whose names share a prefix — e.g. for root `C:\repo\storage`,
 * the path `C:\repo\storage2\evil.txt` starts with the same string but is
 * outside the storage root.
 *
 * This module uses `path.relative()` and rejects when:
 *   - the relative result is absolute (different drive on Windows)
 *   - the relative result starts with `..` (escape)
 *   - the relative result is empty AND `allowRoot` is false (the caller asked
 *     for a non-root subpath, but `rel` resolved back to root)
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface ConfineOptions {
  /**
   * Allow `rel` to resolve to the root itself. Default: true. Callers
   * iterating a tree typically want this; callers asking for "the file at
   * `<root>/<rel>`" can set it false.
   */
  allowRoot?: boolean
}

/**
 * Resolve `rel` against `root` and confirm the result is *strictly inside*
 * (or equal to, when `allowRoot`) `root`. Returns the absolute resolved path
 * on success, `null` on policy violation.
 *
 * Rejects absolute `rel` values up-front — those should never come from
 * untrusted callers, and treating them as relative would silently re-anchor
 * the path under `root` on POSIX while jumping drives on Windows.
 */
export function confineToRoot(
  root: string,
  rel: string,
  options: ConfineOptions = {},
): string | null {
  const allowRoot = options.allowRoot !== false
  if (isAbsolute(rel)) return null
  // Normalise and reject embedded NULs — these can confuse downstream code
  // (sqlite, OS-level path APIs) and never appear in legitimate paths.
  if (rel.includes('\0')) return null

  const normalizedRoot = resolve(root)
  const joined = resolve(normalizedRoot, rel)
  const rel2 = relative(normalizedRoot, joined)

  if (rel2 === '') return allowRoot ? joined : null
  if (rel2.startsWith('..')) return null
  // On Windows `relative` returns an absolute path when the two paths are on
  // different drives (e.g. relative('C:\\x', 'D:\\y')). Reject that too.
  if (isAbsolute(rel2)) return null
  // Defensive: a leading separator after the relative split shouldn't happen
  // but reject if it ever does.
  if (rel2.startsWith(sep)) return null
  return joined
}

/**
 * Cheap syntactic check on a *relative* storage path supplied by the API
 * (project folder paths, etc.). Does not touch the filesystem. Use this in
 * Zod schemas / request validators; use `confineToRoot` when actually
 * resolving for I/O.
 */
export function isSafeRelativePath(rel: string): boolean {
  if (!rel) return false
  if (rel.includes('\0')) return false
  if (isAbsolute(rel)) return false
  // Reject Windows drive-letter prefixes even on POSIX hosts — they will
  // confuse callers that ship rows between platforms.
  if (/^[a-zA-Z]:/.test(rel)) return false
  // Block backslash explicitly to keep stored paths POSIX-shaped, matching
  // the storage adapter's normalisation rules.
  if (rel.includes('\\')) return false
  const parts = rel.split('/').filter((p) => p !== '')
  if (parts.length === 0) return false
  for (const part of parts) {
    if (part === '..' || part === '.') return false
  }
  return true
}


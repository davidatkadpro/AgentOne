import { readdir, readFile, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { isAbsolute, join, basename } from 'node:path'
import type {
  EmailSource,
  EmailSourceListOptions,
  SourceEmailBody,
  SourceEmailDetail,
  SourceEmailSummary,
} from '../source.js'
import { sanitizeEmailHtml } from '../sanitize.js'

/**
 * Local-folder EmailSource for dev / offline use. Reads RFC-5322-ish `.eml`
 * files from a flat directory; the file name is the sourceId.
 *
 * Parsing is intentionally minimal: we split on the first blank line, then
 * read From / Subject / Date / Content-Type headers via case-insensitive
 * line scan. We do NOT implement full MIME multipart decoding; instead we
 * detect the dominant body part via `Content-Type` and decode that. Bodies
 * encoded in quoted-printable or base64 are decoded; otherwise treated as
 * raw text. Production messages should arrive via a Graph adapter; this
 * source exists so the end-to-end flow is testable without OAuth.
 */
export interface MaildirEmailSourceConfig {
  /** Absolute path to the directory containing `.eml` files. */
  root: string
}

export class MaildirEmailSource implements EmailSource {
  readonly kind = 'maildir'

  constructor(private readonly cfg: MaildirEmailSourceConfig) {
    if (!isAbsolute(cfg.root)) {
      throw new Error(`MaildirEmailSource root must be absolute: ${cfg.root}`)
    }
  }

  async list(opts: EmailSourceListOptions = {}): Promise<SourceEmailSummary[]> {
    let entries
    try {
      entries = await readdir(this.cfg.root, { withFileTypes: true })
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return []
      throw err
    }
    const files = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.eml'))
      .map((e) => e.name)
      .sort()

    const out: SourceEmailSummary[] = []
    for (const name of files) {
      const summary = await this.readSummary(name)
      if (opts.sinceMs !== undefined && summary.receivedAt <= opts.sinceMs) continue
      out.push(summary)
      if (opts.limit && out.length >= opts.limit) break
    }
    return out
  }

  async get(sourceId: string): Promise<SourceEmailDetail> {
    const abs = this.resolveFile(sourceId)
    const raw = await readFile(abs, 'utf-8')
    const { headers, body } = splitHeadersAndBody(raw)
    const fileStat = await stat(abs)
    const decoded = decodeBody(headers, body)
    return {
      sourceKind: this.kind,
      sourceId,
      ...parseHeaders(headers, fileStat.mtimeMs),
      snippet: makeSnippet(decoded.text),
      hasAttachments: false,
      body: decoded.text.trim(),
      attachmentNames: [],
    }
  }

  async getBody(sourceId: string): Promise<SourceEmailBody> {
    const abs = this.resolveFile(sourceId)
    const raw = await readFile(abs, 'utf-8')
    const { headers, body } = splitHeadersAndBody(raw)
    const decoded = decodeBody(headers, body)
    if (decoded.kind === 'html') {
      return {
        kind: 'html',
        content: sanitizeEmailHtml(decoded.text),
        attachments: [],
      }
    }
    return {
      kind: 'text',
      content: decoded.text,
      attachments: [],
    }
  }

  async fetchAttachment(): Promise<Buffer> {
    // Maildir source has no MIME parsing in v0.1 — there are no attachments
    // to fetch. The interface keeps the method so production sources can
    // implement it without varying the EmailService contract.
    throw new Error('MaildirEmailSource does not support attachments')
  }

  watch(onNewMessage: (sourceId: string) => void): () => void {
    let watcher: FSWatcher
    try {
      watcher = watch(this.cfg.root, { persistent: false }, (event, filename) => {
        if (!filename) return
        const name = basename(filename.toString())
        if (!name.toLowerCase().endsWith('.eml')) return
        // 'rename' is what node emits on file create on most platforms. We
        // wait a tick to let the writer finish, then verify the file exists
        // before notifying. This is the simplest "stable" detection without
        // pulling in chokidar.
        if (event === 'rename') {
          void this.confirmAndNotify(name, onNewMessage)
        }
      })
    } catch {
      // ENOENT or permission denied — return a no-op unsubscribe so callers
      // can wire `source.watch()` unconditionally.
      return () => {}
    }
    return () => watcher.close()
  }

  private async confirmAndNotify(
    name: string,
    onNewMessage: (sourceId: string) => void,
  ): Promise<void> {
    // Brief debounce — give the writer a moment to flush. Reads stat twice
    // (200ms apart) and only notifies once the size stabilises, otherwise
    // we'd ingest half-written .eml files.
    await new Promise((r) => setTimeout(r, 200))
    let first
    try {
      first = await stat(join(this.cfg.root, name))
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 200))
    let second
    try {
      second = await stat(join(this.cfg.root, name))
    } catch {
      return
    }
    if (first.size === second.size) {
      onNewMessage(name)
    } else {
      // Still writing — try again on the next watcher tick. The watcher will
      // emit another 'rename' once the writer closes.
    }
  }

  private async readSummary(filename: string): Promise<SourceEmailSummary> {
    const abs = join(this.cfg.root, filename)
    const raw = await readFile(abs, 'utf-8')
    const { headers, body } = splitHeadersAndBody(raw)
    const fileStat = await stat(abs)
    const parsed = parseHeaders(headers, fileStat.mtimeMs)
    const decoded = decodeBody(headers, body)
    return {
      sourceKind: this.kind,
      sourceId: filename,
      ...parsed,
      snippet: makeSnippet(decoded.text),
      hasAttachments: false,
    }
  }

  private resolveFile(sourceId: string): string {
    if (sourceId.includes('/') || sourceId.includes('\\') || sourceId.startsWith('..')) {
      throw new Error(`Invalid sourceId: ${sourceId}`)
    }
    return join(this.cfg.root, sourceId)
  }
}

function splitHeadersAndBody(raw: string): { headers: string; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n')
  const idx = normalized.indexOf('\n\n')
  if (idx === -1) return { headers: normalized, body: '' }
  return {
    headers: normalized.slice(0, idx),
    body: normalized.slice(idx + 2),
  }
}

interface HeaderFields {
  receivedAt: number
  fromAddress: string
  fromName: string | null
  subject: string | null
}

function lookupHeader(headers: string, name: string): string | null {
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'im')
  const m = pattern.exec(headers)
  return m ? m[1]!.trim() : null
}

function parseHeaders(headers: string, mtimeMs: number): HeaderFields {
  const fromRaw = lookupHeader(headers, 'From')
  const subject = lookupHeader(headers, 'Subject')
  const dateRaw = lookupHeader(headers, 'Date')
  const { name, address } = parseAddressLine(fromRaw)
  const parsedDate = dateRaw ? Date.parse(dateRaw) : NaN
  return {
    receivedAt: Number.isFinite(parsedDate) ? parsedDate : Math.floor(mtimeMs),
    fromAddress: address,
    fromName: name,
    subject,
  }
}

function parseAddressLine(line: string | null): { name: string | null; address: string } {
  if (!line) return { name: null, address: '' }
  const angle = /^(.*?)<([^>]+)>\s*$/.exec(line)
  if (angle) {
    const name = angle[1]!.trim().replace(/^"|"$/g, '').trim()
    return { name: name.length > 0 ? name : null, address: angle[2]!.trim() }
  }
  return { name: null, address: line.trim() }
}

interface DecodedBody {
  kind: 'text' | 'html'
  text: string
}

function decodeBody(headers: string, rawBody: string): DecodedBody {
  const contentType = lookupHeader(headers, 'Content-Type') ?? 'text/plain'
  const transferEncoding = (
    lookupHeader(headers, 'Content-Transfer-Encoding') ?? '7bit'
  ).toLowerCase()
  const isHtml = /text\/html/i.test(contentType)

  let decoded = rawBody
  if (transferEncoding === 'quoted-printable') {
    decoded = decodeQuotedPrintable(rawBody)
  } else if (transferEncoding === 'base64') {
    try {
      decoded = Buffer.from(rawBody.replace(/\s+/g, ''), 'base64').toString('utf-8')
    } catch {
      decoded = rawBody
    }
  }
  return { kind: isHtml ? 'html' : 'text', text: decoded }
}

function decodeQuotedPrintable(input: string): string {
  // RFC 2045 §6.7. Soft line breaks (=\n) get removed; =XX hex pairs become
  // a single byte each. Final string is decoded as UTF-8.
  const cleaned = input.replace(/=(?:\r?\n|\r)/g, '')
  const bytes: number[] = []
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i]!
    if (c === '=' && i + 2 < cleaned.length) {
      const hex = cleaned.substring(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
        continue
      }
    }
    bytes.push(c.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf-8')
}

function makeSnippet(body: string): string {
  return body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

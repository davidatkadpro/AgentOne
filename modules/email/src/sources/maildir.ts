import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  EmailSource,
  EmailSourceListOptions,
  SourceEmailDetail,
  SourceEmailSummary,
} from '../source.js'

/**
 * Local-folder EmailSource for dev / offline use. Reads RFC-5322-ish `.eml`
 * files from a flat directory; the file name is the sourceId.
 *
 * Parsing is intentionally minimal: we split on the first blank line, then
 * read From / Subject / Date / Message-ID headers via case-insensitive
 * line scan. We do NOT handle MIME multipart, quoted-printable bodies, or
 * RFC 2047 encoded-word headers. Production messages should arrive via a
 * Graph adapter; this source exists so the end-to-end flow is testable
 * without OAuth.
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
    return {
      sourceKind: this.kind,
      sourceId,
      ...parseHeaders(headers, fileStat.mtimeMs),
      snippet: makeSnippet(body),
      hasAttachments: false,
      body: body.trim(),
      attachmentNames: [],
    }
  }

  async fetchAttachment(): Promise<Buffer> {
    // Maildir source has no MIME parsing in v0.1 — there are no attachments
    // to fetch. The interface keeps the method so production sources can
    // implement it without varying the EmailService contract.
    throw new Error('MaildirEmailSource does not support attachments')
  }

  private async readSummary(filename: string): Promise<SourceEmailSummary> {
    const abs = join(this.cfg.root, filename)
    const raw = await readFile(abs, 'utf-8')
    const { headers, body } = splitHeadersAndBody(raw)
    const fileStat = await stat(abs)
    const parsed = parseHeaders(headers, fileStat.mtimeMs)
    return {
      sourceKind: this.kind,
      sourceId: filename,
      ...parsed,
      snippet: makeSnippet(body),
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

function parseHeaders(headers: string, mtimeMs: number): HeaderFields {
  const lookup = (name: string): string | null => {
    const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'im')
    const m = pattern.exec(headers)
    return m ? m[1].trim() : null
  }
  const fromRaw = lookup('From')
  const subject = lookup('Subject')
  const dateRaw = lookup('Date')
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
  // Pattern: 'Name <addr@host>' or bare 'addr@host'
  const angle = /^(.*?)<([^>]+)>\s*$/.exec(line)
  if (angle) {
    const name = angle[1].trim().replace(/^"|"$/g, '').trim()
    return { name: name.length > 0 ? name : null, address: angle[2].trim() }
  }
  return { name: null, address: line.trim() }
}

function makeSnippet(body: string): string {
  return body
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** Lightweight summary returned by EmailSource.list — the shape the
 *  EmailService.ingestEmail input expects, plus the sourceKind constant
 *  the source advertises. Bodies and attachments stay in the source until
 *  the email is filed. */
export interface SourceEmailSummary {
  sourceKind: string
  sourceId: string
  receivedAt: number
  fromAddress: string
  fromName: string | null
  subject: string | null
  snippet: string | null
  hasAttachments: boolean
}

/** Full message body + attachment list returned by EmailSource.get. */
export interface SourceEmailDetail extends SourceEmailSummary {
  /** Plain-text body; HTML-only sources should provide a rendered fallback. */
  body: string
  attachmentNames: string[]
}

/** Rendered body returned by EmailSource.getBody — the shape the
 *  `/api/email/:id/body` route returns. `content` is plain text (kind:'text')
 *  or sanitised HTML (kind:'html'). Sanitisation is the source's
 *  responsibility: by the time this value crosses the route boundary it must
 *  be safe to render in the browser. */
export interface SourceEmailBody {
  kind: 'text' | 'html'
  content: string
  attachments: Array<{
    filename: string
    bytes: number
    contentType: string | null
  }>
}

export interface EmailSourceListOptions {
  /** Skip messages received at or before this ms-epoch. */
  sinceMs?: number
  limit?: number
}

/**
 * Narrow interface every email connector implements. Production default is
 * GraphEmailSource (Microsoft Graph); MaildirEmailSource is the dev/offline
 * fallback that reads .eml files from a local folder.
 *
 * No outbound mail in v2 — the surface is read + mark + fetch only.
 */
export interface EmailSource {
  /** Stable identifier the service stores as `email.source_kind`. */
  readonly kind: string

  list(opts?: EmailSourceListOptions): Promise<SourceEmailSummary[]>
  get(sourceId: string): Promise<SourceEmailDetail>
  /** Returns the rendered body for the React detail view. Implementations
   *  MUST sanitise HTML before returning. Defaults to plain text when not
   *  overridden (built from `get(sourceId).body`). */
  getBody?(sourceId: string): Promise<SourceEmailBody>
  fetchAttachment(sourceId: string, attachmentName: string): Promise<Buffer>

  /** Optional — sources that track read state remotely can implement this so
   *  the UI's "mark read" propagates back to the mailbox. Sources that don't
   *  (e.g. a maildir folder) just leave it undefined. */
  markRead?(sourceId: string, isRead: boolean): Promise<void>

  /** Optional — sources that can push new-message notifications start a
   *  watcher here. The callback fires once per newly-detected message; the
   *  service maps it to `ingestEmail`. Returns an unsubscribe function. */
  watch?(onNewMessage: (sourceId: string) => void): () => void
}

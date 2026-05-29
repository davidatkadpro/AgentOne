import type {
  EmailSource,
  EmailSourceListOptions,
  SourceEmailBody,
  SourceEmailDetail,
  SourceEmailSummary,
} from '../source.js'
import type { ActorContext, EmailService } from '../service.js'
import type { GraphHttpClient, GraphMessageDetail } from '../../../../src/modules/m365/source.js'
import type { SecretVault } from '../../../../src/storage/secret-vault.js'
import { sanitizeEmailHtml } from '../sanitize.js'

/** Thrown by the token provider when no usable connection is available. The
 *  routes/poller treat this as "not connected" rather than a hard error. */
export class M365NotConnectedError extends Error {
  constructor() {
    super('M365 not connected')
    this.name = 'M365NotConnectedError'
  }
}

export interface GraphAuth {
  /** Returns a valid bearer token, refreshing (and re-persisting) if expired.
   *  Throws M365NotConnectedError when there is no connection or refresh fails. */
  getAccessToken(): Promise<string>
}

export interface CreateGraphAuthDeps {
  service: EmailService
  vault: SecretVault
  client: GraphHttpClient
  /** Test-only clock override. */
  now?: () => number
  /** Refresh this many ms before actual expiry to avoid edge races. */
  skewMs?: number
}

const HTTP_ACTOR: ActorContext = { actor: { type: 'user' } }

/**
 * Owns the access-token lifecycle for the GraphEmailSource: read the stored
 * connection, refresh when (near-)expired, re-encrypt and persist the rotated
 * tokens. Direct port of invoicing's `withAuth()` helper.
 */
export function createGraphAuth(deps: CreateGraphAuthDeps): GraphAuth {
  const now = deps.now ?? Date.now
  const skewMs = deps.skewMs ?? 60_000
  return {
    async getAccessToken() {
      const conn = deps.service.getM365Connection()
      if (!conn) throw new M365NotConnectedError()
      if (conn.tokenExpiresAt - skewMs > now()) {
        try {
          return deps.vault.decrypt(conn.accessTokenEncrypted)
        } catch {
          throw new M365NotConnectedError()
        }
      }
      // Expired (or within the skew window) — rotate via refresh_token.
      let refreshToken: string
      try {
        refreshToken = deps.vault.decrypt(conn.refreshTokenEncrypted)
      } catch {
        throw new M365NotConnectedError()
      }
      let tokens
      try {
        tokens = await deps.client.refreshTokens(refreshToken)
      } catch {
        throw new M365NotConnectedError()
      }
      deps.service.upsertM365Connection(
        {
          accountName: conn.accountName,
          accountEmail: conn.accountEmail,
          accessTokenEncrypted: deps.vault.encrypt(tokens.accessToken),
          refreshTokenEncrypted: deps.vault.encrypt(tokens.refreshToken),
          tokenExpiresAt: now() + tokens.expiresIn * 1000,
        },
        HTTP_ACTOR,
      )
      return tokens.accessToken
    },
  }
}

export interface GraphEmailSourceDeps {
  client: GraphHttpClient
  auth: GraphAuth
}

/**
 * Microsoft 365 EmailSource over Graph. Read + mark only. No `watch()` — Graph
 * push needs a public webhook endpoint (out of scope), so freshness comes from
 * the GraphEmailPoller instead.
 */
export class GraphEmailSource implements EmailSource {
  readonly kind = 'graph'

  constructor(private readonly deps: GraphEmailSourceDeps) {}

  async list(opts: EmailSourceListOptions = {}): Promise<SourceEmailSummary[]> {
    const token = await this.deps.auth.getAccessToken()
    const listOpts: { sinceMs?: number; top?: number } = {}
    if (opts.sinceMs !== undefined) listOpts.sinceMs = opts.sinceMs
    if (opts.limit !== undefined) listOpts.top = opts.limit
    const msgs = await this.deps.client.listMessages(token, listOpts)
    return msgs.map((m) => ({
      sourceKind: this.kind,
      sourceId: m.id,
      receivedAt: toMs(m.receivedDateTime),
      fromAddress: m.fromAddress ?? '',
      fromName: m.fromName,
      subject: m.subject,
      snippet: m.bodyPreview,
      hasAttachments: m.hasAttachments,
    }))
  }

  async get(sourceId: string): Promise<SourceEmailDetail> {
    const token = await this.deps.auth.getAccessToken()
    const m = await this.deps.client.getMessage(token, sourceId)
    if (!m) throw new Error(`Graph message not found: ${sourceId}`)
    const attachmentNames = m.hasAttachments
      ? (await this.deps.client.listAttachments(token, sourceId)).map((a) => a.name)
      : []
    return {
      sourceKind: this.kind,
      sourceId,
      receivedAt: toMs(m.receivedDateTime),
      fromAddress: m.fromAddress ?? '',
      fromName: m.fromName,
      subject: m.subject,
      snippet: m.bodyPreview,
      hasAttachments: m.hasAttachments,
      body: bodyToPlainText(m),
      attachmentNames,
    }
  }

  async getBody(sourceId: string): Promise<SourceEmailBody> {
    const token = await this.deps.auth.getAccessToken()
    const m = await this.deps.client.getMessage(token, sourceId)
    if (!m) throw new Error(`Graph message not found: ${sourceId}`)
    const attachments = m.hasAttachments
      ? (await this.deps.client.listAttachments(token, sourceId)).map((a) => ({
          filename: a.name,
          bytes: a.size,
          contentType: a.contentType,
        }))
      : []
    if (m.body?.contentType === 'html') {
      return { kind: 'html', content: sanitizeEmailHtml(m.body.content), attachments }
    }
    return { kind: 'text', content: m.body?.content ?? m.bodyPreview ?? '', attachments }
  }

  async fetchAttachment(sourceId: string, attachmentName: string): Promise<Buffer> {
    const token = await this.deps.auth.getAccessToken()
    const attachments = await this.deps.client.listAttachments(token, sourceId)
    const match = attachments.find((a) => a.name === attachmentName)
    if (!match) throw new Error(`Attachment not found: ${attachmentName}`)
    return this.deps.client.getAttachmentContent(token, sourceId, match.id)
  }

  async markRead(sourceId: string, isRead: boolean): Promise<void> {
    const token = await this.deps.auth.getAccessToken()
    await this.deps.client.markRead(token, sourceId, isRead)
  }
}

function toMs(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : Date.now()
}

function bodyToPlainText(m: GraphMessageDetail): string {
  if (!m.body) return m.bodyPreview ?? ''
  if (m.body.contentType === 'html') {
    // get().body is the plain-text projection (getBody() renders sanitised
    // HTML). Strip tags so callers that read .body don't get raw markup.
    return m.body.content
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return m.body.content.trim()
}

const POLLER_ACTOR: ActorContext = { actor: { type: 'scheduler', id: 'email-poll' } }

export interface GraphEmailPollerOptions {
  service: EmailService
  source: EmailSource
  /** Interval in ms (default 5 min). */
  intervalMs?: number
  /** Test-only clock override. */
  now?: () => number
}

/**
 * Background poll loop: pull the inbox and ingest new messages. Pauses when no
 * connection exists; records `last_poll_at` on success and `last_error_json`
 * on failure. Fire-and-forget — a transient Graph outage never crashes the host.
 *
 * Mirrors src/modules/qbo/poller.ts (Graph just has no per-entity fan-out).
 */
export class GraphEmailPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private intervalMs: number

  constructor(private opts: GraphEmailPollerOptions) {
    this.intervalMs = opts.intervalMs ?? 5 * 60_000
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      ;(this.timer as { unref(): void }).unref()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async runOnce(): Promise<void> {
    // Skip quietly when disconnected — don't spam the error field.
    if (!this.opts.service.getM365Connection()) return
    const now = (this.opts.now ?? Date.now)()
    try {
      await this.opts.service.pollSource(this.opts.source, POLLER_ACTOR)
      this.opts.service.recordM365PollTs(now)
    } catch (err) {
      if (err instanceof M365NotConnectedError) return
      const message = err instanceof Error ? err.message : String(err)
      this.opts.service.recordM365Error({ code: 'GRAPH_ERROR', message })
    }
  }
}

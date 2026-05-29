/**
 * Microsoft Graph HTTP client surface. Kept narrow on purpose: only the
 * operations the OAuth routes and the GraphEmailSource actually need (read +
 * mark, no outbound mail). Implementations are pluggable so tests can pass a
 * fake without standing up a real Graph tenant.
 *
 * Mirrors src/modules/qbo/source.ts.
 */

export interface GraphTokenSet {
  accessToken: string
  refreshToken: string
  /** Seconds-from-now access-token TTL. */
  expiresIn: number
}

/** The bits of `/me` we surface in the connection status (account label). */
export interface GraphMe {
  displayName: string | null
  mail: string | null
  userPrincipalName: string | null
}

/** Message list projection — the `$select` we ask Graph for. */
export interface GraphMessageSummary {
  id: string
  receivedDateTime: string // ISO-8601
  subject: string | null
  bodyPreview: string | null
  fromName: string | null
  fromAddress: string | null
  hasAttachments: boolean
  isRead: boolean
}

export interface GraphMessageDetail extends GraphMessageSummary {
  body: { contentType: 'text' | 'html'; content: string } | null
}

export interface GraphAttachmentMeta {
  id: string
  name: string
  size: number
  contentType: string | null
}

export interface GraphListOptions {
  /** Skip messages received at or before this ms-epoch (Graph `$filter`). */
  sinceMs?: number
  /** Page size / cap (`$top`). */
  top?: number
}

export interface GraphHttpClient {
  /** Exchange an OAuth authorization code for tokens. */
  exchangeCode(code: string, redirectUri: string): Promise<GraphTokenSet>
  /** Refresh tokens via the refresh_token grant. */
  refreshTokens(refreshToken: string): Promise<GraphTokenSet>
  /** Fetch the signed-in account (used to label the connection). Null on failure. */
  me(accessToken: string): Promise<GraphMe | null>
  /** List inbox messages, newest first. */
  listMessages(accessToken: string, opts?: GraphListOptions): Promise<GraphMessageSummary[]>
  /** Fetch a single message with its body. Null on 404. */
  getMessage(accessToken: string, id: string): Promise<GraphMessageDetail | null>
  /** List a message's file attachments (metadata only). */
  listAttachments(accessToken: string, messageId: string): Promise<GraphAttachmentMeta[]>
  /** Fetch a single attachment's raw bytes by its Graph attachment id. */
  getAttachmentContent(
    accessToken: string,
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer>
  /** Set a message's read state in the mailbox (PATCH isRead). */
  markRead(accessToken: string, id: string, isRead: boolean): Promise<void>
}

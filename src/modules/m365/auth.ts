import type {
  GraphAttachmentMeta,
  GraphHttpClient,
  GraphListOptions,
  GraphMe,
  GraphMessageDetail,
  GraphMessageSummary,
  GraphTokenSet,
} from './source.js'

export interface GraphHttpClientOptions {
  clientId: string
  clientSecret: string
  /** Entra v2 token endpoint (tenant-scoped). */
  tokenUrl: string
  /** Space-delimited delegated scopes (must include offline_access). */
  scopes: string
  /** Graph API base; defaults to the v1.0 production endpoint. */
  apiBaseUrl?: string
  /** Inject a fetch impl (test-only). */
  fetchImpl?: typeof fetch
}

const DEFAULT_API_BASE = 'https://graph.microsoft.com/v1.0'

// $select projections — keep them tight so we don't pull whole bodies on list.
const SUMMARY_SELECT = 'id,receivedDateTime,subject,bodyPreview,from,hasAttachments,isRead'
const DETAIL_SELECT = `${SUMMARY_SELECT},body`

interface RawGraphMessage {
  id: string
  receivedDateTime: string
  subject: string | null
  bodyPreview: string | null
  from?: { emailAddress?: { name?: string; address?: string } } | null
  hasAttachments?: boolean
  isRead?: boolean
  body?: { contentType?: string; content?: string } | null
}

function mapSummary(m: RawGraphMessage): GraphMessageSummary {
  return {
    id: m.id,
    receivedDateTime: m.receivedDateTime,
    subject: m.subject ?? null,
    bodyPreview: m.bodyPreview ?? null,
    fromName: m.from?.emailAddress?.name ?? null,
    fromAddress: m.from?.emailAddress?.address ?? null,
    hasAttachments: m.hasAttachments === true,
    isRead: m.isRead === true,
  }
}

/**
 * Real-world Microsoft Graph client over the global `fetch`. Confidential
 * client (client_secret in the token request body, per the Entra v2 protocol).
 * Read + mark only — no outbound mail in v2.
 *
 * Mirrors src/modules/qbo/auth.ts: no built-in retry/backoff; the routes treat
 * an upstream failure as terminal and the poller swallows individual errors.
 */
export class HttpGraphClient implements GraphHttpClient {
  private fetchImpl: typeof fetch
  private apiBase: string

  constructor(private opts: GraphHttpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.apiBase = opts.apiBaseUrl ?? DEFAULT_API_BASE
  }

  private async tokenRequest(params: Record<string, string>): Promise<GraphTokenSet> {
    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: this.opts.scopes,
      ...params,
    })
    const res = await this.fetchImpl(this.opts.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`Graph token ${res.status}: ${txt.slice(0, 200)}`)
    }
    const j = (await res.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresIn: j.expires_in,
    }
  }

  async exchangeCode(code: string, redirectUri: string): Promise<GraphTokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    })
  }

  async refreshTokens(refreshToken: string): Promise<GraphTokenSet> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
  }

  private async graphRequest(
    accessToken: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${accessToken}`)
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    const res = await this.fetchImpl(url, { ...init, headers })
    if (!res.ok && res.status !== 404) {
      const txt = await res.text().catch(() => '')
      throw new Error(`Graph ${res.status}: ${txt.slice(0, 500)}`)
    }
    return res
  }

  async me(accessToken: string): Promise<GraphMe | null> {
    const res = await this.graphRequest(
      accessToken,
      '/me?$select=displayName,mail,userPrincipalName',
    ).catch(() => null)
    if (!res || res.status === 404) return null
    const j = (await res.json()) as {
      displayName?: string
      mail?: string
      userPrincipalName?: string
    }
    return {
      displayName: j.displayName ?? null,
      mail: j.mail ?? null,
      userPrincipalName: j.userPrincipalName ?? null,
    }
  }

  async listMessages(
    accessToken: string,
    opts: GraphListOptions = {},
  ): Promise<GraphMessageSummary[]> {
    const top = opts.top ?? 50
    const params = new URLSearchParams({
      $select: SUMMARY_SELECT,
      $orderby: 'receivedDateTime desc',
      $top: String(top),
    })
    if (opts.sinceMs !== undefined) {
      // Graph wants an ISO timestamp; `gt` excludes messages received at or
      // before `sinceMs` (the EmailSource contract).
      params.set('$filter', `receivedDateTime gt ${new Date(opts.sinceMs).toISOString()}`)
    }
    const res = await this.graphRequest(
      accessToken,
      `/me/mailFolders/inbox/messages?${params.toString()}`,
    )
    const j = (await res.json()) as { value?: RawGraphMessage[] }
    return (j.value ?? []).map(mapSummary)
  }

  async getMessage(accessToken: string, id: string): Promise<GraphMessageDetail | null> {
    const res = await this.graphRequest(
      accessToken,
      `/me/messages/${encodeURIComponent(id)}?$select=${DETAIL_SELECT}`,
    )
    if (res.status === 404) return null
    const m = (await res.json()) as RawGraphMessage
    const summary = mapSummary(m)
    const contentType = m.body?.contentType?.toLowerCase() === 'html' ? 'html' : 'text'
    return {
      ...summary,
      body: m.body ? { contentType, content: m.body.content ?? '' } : null,
    }
  }

  async listAttachments(accessToken: string, messageId: string): Promise<GraphAttachmentMeta[]> {
    const res = await this.graphRequest(
      accessToken,
      `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,size,contentType`,
    )
    if (res.status === 404) return []
    const j = (await res.json()) as {
      value?: Array<{ id: string; name?: string; size?: number; contentType?: string }>
    }
    return (j.value ?? [])
      .filter((a) => typeof a.name === 'string' && a.name.length > 0)
      .map((a) => ({
        id: a.id,
        name: a.name as string,
        size: a.size ?? 0,
        contentType: a.contentType ?? null,
      }))
  }

  async getAttachmentContent(
    accessToken: string,
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer> {
    // `/$value` returns the raw file bytes for a fileAttachment.
    const res = await this.graphRequest(
      accessToken,
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(
        attachmentId,
      )}/$value`,
    )
    if (res.status === 404) {
      throw new Error('Graph attachment not found')
    }
    const buf = await res.arrayBuffer()
    return Buffer.from(buf)
  }

  async markRead(accessToken: string, id: string, isRead: boolean): Promise<void> {
    await this.graphRequest(accessToken, `/me/messages/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ isRead }),
    })
  }
}

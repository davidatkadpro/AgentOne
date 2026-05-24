import type {
  QboAuthHeader,
  QboHttpClient,
  QboInvoiceDoc,
  QboTokenSet,
} from './source.js'

export interface QboHttpClientOptions {
  clientId: string
  clientSecret: string
  /** Override the QBO API base URL (default: production sandbox). */
  apiBaseUrl?: string
  /** Override the token URL (default: production). */
  tokenUrl?: string
  /** Override the revoke URL. */
  revokeUrl?: string
  /** Inject a fetch impl (test-only). */
  fetchImpl?: typeof fetch
}

const DEFAULT_API_BASE = 'https://quickbooks.api.intuit.com/v3/company'
const DEFAULT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const DEFAULT_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'

/**
 * Real-world QBO HTTP client. Uses the global `fetch`. Production OAuth needs
 * client_id/secret and the `OAuth 2.0 PKCE` flow described at
 * https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
 *
 * We don't ship our own retry/backoff — the routes treat 502 as terminal and
 * leave the operator to re-trigger. The poller swallows individual failures.
 */
export class HttpQboClient implements QboHttpClient {
  private fetchImpl: typeof fetch
  private apiBase: string
  private tokenUrl: string
  private revokeUrl: string

  constructor(private opts: QboHttpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.apiBase = opts.apiBaseUrl ?? DEFAULT_API_BASE
    this.tokenUrl = opts.tokenUrl ?? DEFAULT_TOKEN_URL
    this.revokeUrl = opts.revokeUrl ?? DEFAULT_REVOKE_URL
  }

  private async qboRequest(
    auth: QboAuthHeader,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = `${this.apiBase}/${auth.realmId}${path}`
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${auth.accessToken}`)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    const res = await this.fetchImpl(url, { ...init, headers })
    if (!res.ok && res.status !== 404) {
      const txt = await res.text().catch(() => '')
      throw new Error(`QBO ${res.status}: ${txt.slice(0, 500)}`)
    }
    return res
  }

  async createInvoice(
    auth: QboAuthHeader,
    doc: Omit<QboInvoiceDoc, 'Id'>,
  ): Promise<QboInvoiceDoc> {
    const res = await this.qboRequest(auth, '/invoice', {
      method: 'POST',
      body: JSON.stringify(doc),
    })
    const body = (await res.json()) as { Invoice: QboInvoiceDoc }
    return body.Invoice
  }

  async updateInvoice(auth: QboAuthHeader, doc: QboInvoiceDoc): Promise<QboInvoiceDoc> {
    const res = await this.qboRequest(auth, '/invoice?operation=update', {
      method: 'POST',
      body: JSON.stringify(doc),
    })
    const body = (await res.json()) as { Invoice: QboInvoiceDoc }
    return body.Invoice
  }

  async getInvoice(auth: QboAuthHeader, qboId: string): Promise<QboInvoiceDoc | null> {
    const res = await this.qboRequest(auth, `/invoice/${qboId}`, { method: 'GET' })
    if (res.status === 404) return null
    const body = (await res.json()) as { Invoice: QboInvoiceDoc }
    return body.Invoice ?? null
  }

  async exchangeCode(code: string, redirectUri: string): Promise<QboTokenSet> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString(
      'base64',
    )
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    })
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`QBO token exchange ${res.status}: ${txt.slice(0, 200)}`)
    }
    const j = (await res.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      realmId?: string
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresIn: j.expires_in,
      ...(j.realmId !== undefined && { realmId: j.realmId }),
    }
  }

  async refreshTokens(refreshToken: string): Promise<QboTokenSet> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString(
      'base64',
    )
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`QBO refresh ${res.status}: ${txt.slice(0, 200)}`)
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

  async revoke(token: string): Promise<void> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString(
      'base64',
    )
    await this.fetchImpl(this.revokeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token }),
    }).catch(() => {
      // best-effort; QBO revoke can fail if already revoked.
    })
  }

  async companyInfo(auth: QboAuthHeader): Promise<{ CompanyName: string } | null> {
    const res = await this.qboRequest(auth, `/companyinfo/${auth.realmId}`, {
      method: 'GET',
    }).catch(() => null)
    if (!res || res.status === 404) return null
    const body = (await res.json()) as { CompanyInfo: { CompanyName: string } }
    return body.CompanyInfo ?? null
  }
}

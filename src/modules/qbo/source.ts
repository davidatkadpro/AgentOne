/**
 * QBO HTTP client surface. Kept narrow on purpose: only the operations the
 * push/pull/reconcile routes actually need. Implementations are pluggable so
 * tests can pass a fake without standing up a sandbox.
 */

export interface QboLineItem {
  id?: string
  description: string
  amount: number
  qty?: number
  unitPrice?: number
}

/** Minimal QBO Invoice shape we round-trip. The real QBO REST API returns
 *  much more — we only project the fields drift detection cares about. */
export interface QboInvoiceDoc {
  Id: string
  DocNumber: string
  TotalAmt: number
  Balance: number
  CustomerRef?: { value: string; name?: string }
  TxnDate?: string                      // ISO date
  DueDate?: string                      // ISO date
  Line: QboLineItem[]
  SyncToken?: string
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string }
}

export interface QboAuthHeader {
  accessToken: string
  realmId: string
}

export interface QboHttpClient {
  /** Create a new Invoice in QBO. Returns the created doc. */
  createInvoice(auth: QboAuthHeader, doc: Omit<QboInvoiceDoc, 'Id'>): Promise<QboInvoiceDoc>
  /** Update an existing Invoice. Requires Id + SyncToken per QBO contract. */
  updateInvoice(auth: QboAuthHeader, doc: QboInvoiceDoc): Promise<QboInvoiceDoc>
  /** Fetch an Invoice by QBO id. Returns null on 404. */
  getInvoice(auth: QboAuthHeader, qboId: string): Promise<QboInvoiceDoc | null>
  /** Exchange an OAuth code for tokens. */
  exchangeCode(code: string, redirectUri: string): Promise<QboTokenSet>
  /** Refresh tokens via refresh_token grant. */
  refreshTokens(refreshToken: string): Promise<QboTokenSet>
  /** Revoke a refresh token (best-effort; never throws). */
  revoke(token: string): Promise<void>
  /** Fetch company info (used to populate `companyName`). */
  companyInfo(auth: QboAuthHeader): Promise<{ CompanyName: string } | null>
}

export interface QboTokenSet {
  accessToken: string
  refreshToken: string
  /** Seconds-from-now access token TTL. */
  expiresIn: number
  realmId?: string
}

/**
 * A no-op client useful in tests / dev environments without QBO creds. Every
 * method throws unless you override it with a stub. We keep the constructor
 * argument optional so wiring it as a fallback is one line at the call site.
 */
export class NullQboClient implements QboHttpClient {
  constructor(private overrides: Partial<QboHttpClient> = {}) {}
  createInvoice(auth: QboAuthHeader, doc: Omit<QboInvoiceDoc, 'Id'>): Promise<QboInvoiceDoc> {
    if (this.overrides.createInvoice) return this.overrides.createInvoice(auth, doc)
    return Promise.reject(new Error('QBO not configured: createInvoice unavailable'))
  }
  updateInvoice(auth: QboAuthHeader, doc: QboInvoiceDoc): Promise<QboInvoiceDoc> {
    if (this.overrides.updateInvoice) return this.overrides.updateInvoice(auth, doc)
    return Promise.reject(new Error('QBO not configured: updateInvoice unavailable'))
  }
  getInvoice(auth: QboAuthHeader, qboId: string): Promise<QboInvoiceDoc | null> {
    if (this.overrides.getInvoice) return this.overrides.getInvoice(auth, qboId)
    return Promise.reject(new Error('QBO not configured: getInvoice unavailable'))
  }
  exchangeCode(code: string, redirectUri: string): Promise<QboTokenSet> {
    if (this.overrides.exchangeCode) return this.overrides.exchangeCode(code, redirectUri)
    return Promise.reject(new Error('QBO not configured: exchangeCode unavailable'))
  }
  refreshTokens(refreshToken: string): Promise<QboTokenSet> {
    if (this.overrides.refreshTokens) return this.overrides.refreshTokens(refreshToken)
    return Promise.reject(new Error('QBO not configured: refreshTokens unavailable'))
  }
  revoke(token: string): Promise<void> {
    if (this.overrides.revoke) return this.overrides.revoke(token)
    return Promise.resolve()
  }
  companyInfo(auth: QboAuthHeader): Promise<{ CompanyName: string } | null> {
    if (this.overrides.companyInfo) return this.overrides.companyInfo(auth)
    return Promise.resolve(null)
  }
}

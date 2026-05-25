import { z } from 'zod'
import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { renderPandoc } from '../../../src/render/pandoc.js'
import { moneyNonNegative, moneyPositive, qtyNonNegative } from '../../../src/modules/numeric.js'
import { escapeBlock, escapeTableCell, pandocSafeInputArgs } from '../../../src/render/markdown-escape.js'
import { mapDomainError } from '../../../src/errors/domain.js'
import type { EventBus } from '../../../src/core/events.js'
import type { SecretVault } from '../../../src/storage/secret-vault.js'
import type { QboHttpClient } from '../../../src/modules/qbo/source.js'
import type { OAuthStateStore } from '../../../src/modules/qbo/oauth-state.js'
import { localToQbo } from '../../../src/modules/qbo/push.js'
import { detectDrift, buildSnapshots } from '../../../src/modules/qbo/pull.js'
import {
  type ActorContext,
  type InvoicingService,
  type InvoiceStatus,
  type LineKind,
  type PaymentMethod,
  type SyncStatus,
} from './service.js'

const execFileAsync = promisify(execFile)

const LineKindEnum: z.ZodType<LineKind> = z.enum(['fixed', 'time_and_materials', 'unit'])
const InvoiceStatusEnum: z.ZodType<InvoiceStatus> = z.enum([
  'draft',
  'issued',
  'partial',
  'paid',
  'void',
])
const SyncStatusEnum: z.ZodType<SyncStatus> = z.enum([
  'local',
  'pending',
  'synced',
  'drift',
  'failed',
])
const PaymentMethodEnum: z.ZodType<PaymentMethod> = z.enum([
  'check',
  'ach',
  'card',
  'wire',
  'cash',
  'other',
])

const CreateInvoiceBody = z.object({
  proposalId: z.string().optional(),
  taxAmount: moneyNonNegative().optional(),
  dueDate: z.number().int().optional(),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  lines: z.array(
    z.object({
      kind: LineKindEnum.optional(),
      description: z.string().min(1),
      qty: qtyNonNegative().optional(),
      unit: z.string().optional(),
      unitPrice: moneyNonNegative().optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
  ),
})

const CreateFromProposalBody = z.object({
  proposalId: z.string().min(1),
  taxAmount: moneyNonNegative().optional(),
  dueDate: z.number().int().optional(),
  notes: z.string().optional(),
})

const RecordPaymentBody = z.object({
  amount: moneyPositive(),
  receivedAt: z.number().int().optional(),
  method: PaymentMethodEnum.optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
})

const PatchStatusBody = z.object({ status: InvoiceStatusEnum })

const UpdateInvoiceBody = z
  .object({
    status: InvoiceStatusEnum.optional(),
    taxAmount: moneyNonNegative().optional(),
    dueDate: z.number().int().nullable().optional(),
    notes: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
    lines: z
      .array(
        z.object({
          id: z.string().optional(),
          kind: LineKindEnum.optional(),
          description: z.string().min(1),
          qty: qtyNonNegative().optional(),
          unit: z.string().nullable().optional(),
          unitPrice: moneyNonNegative().optional(),
          metadata: z.record(z.unknown()).optional(),
        }),
      )
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Empty body' })

const PushBody = z.object({ force: z.boolean().optional() })
const ReconcileBody = z.object({
  strategy: z.enum(['keep_local', 'accept_qbo', 'merge']),
  merged: z.record(z.unknown()).optional(),
})

const ProjectIdParams = z.object({ projectId: z.string().min(1) })
const InvoiceIdParams = z.object({ id: z.string().min(1) })

const HTTP_ACTOR: ActorContext = { actor: { type: 'user' } }

export interface RegisterInvoicingRoutesDeps {
  service: InvoicingService
  eventBus?: EventBus
  /** Whether Pandoc is on PATH; gates PDF rendering. */
  pandocAvailable?: boolean
  /** Required for QBO sync routes. Missing it disables push/pull/reconcile
   *  (they return 503 QBO_NOT_CONFIGURED). */
  qbo?: {
    client: QboHttpClient
    vault: SecretVault
    oauthState: OAuthStateStore
    /** OAuth client_id and client_secret. From env. */
    clientId: string
    clientSecret: string
    /** Redirect URI registered with QBO. */
    redirectUri: string
    /** Authorize URL — overridable for testing. */
    authorizeUrl?: string
    /** SPA URL to redirect to after callback (e.g. `/settings?tab=integrations`). */
    spaCallbackUrl?: string
  }
}

const DEFAULT_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2'
const DEFAULT_SPA_CALLBACK = '/settings?tab=integrations'

// Strict query schema for GET /invoicing/invoices. Replaces hand-rolled
// parsing that silently dropped invalid filters (broadening the result set
// instead of returning 400) and had no upper bound on `limit` (a caller
// could request millions of rows). Both behaviours surprised callers and
// could degrade the DB.
const ListInvoicesQuery = z.object({
  projectId: z.string().min(1).optional(),
  status: z
    .union([InvoiceStatusEnum, z.array(InvoiceStatusEnum).min(1)])
    .optional(),
  syncStatus: z
    .union([SyncStatusEnum, z.array(SyncStatusEnum).min(1)])
    .optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
})

function projectionStatus(s: InvoiceStatus): 'draft' | 'issued' | 'partially_paid' | 'paid' | 'void' {
  return s === 'partial' ? 'partially_paid' : s
}

function asArr<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v]
}

export async function registerInvoicingRoutes(
  app: FastifyInstance,
  deps: RegisterInvoicingRoutesDeps,
): Promise<void> {
  const { service } = deps
  const pandocAvailable = deps.pandocAvailable ?? false

  function bothPaths(suffix: string): string[] {
    return [`/api/v1${suffix}`, `/api${suffix}`]
  }

  // ── Create invoice (project-scoped) ───────────────────────────────────

  for (const url of bothPaths('/projects/:projectId/invoices')) {
    app.post(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = CreateInvoiceBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        const input: Parameters<typeof service.createInvoice>[0] = {
          projectId: params.data.projectId,
          lines: body.data.lines,
        }
        if (body.data.proposalId !== undefined) input.proposalId = body.data.proposalId
        if (body.data.taxAmount !== undefined) input.taxAmount = body.data.taxAmount
        if (body.data.dueDate !== undefined) input.dueDate = body.data.dueDate
        if (body.data.notes !== undefined) input.notes = body.data.notes
        if (body.data.metadata !== undefined) input.metadata = body.data.metadata
        const invoice = service.createInvoice(input, HTTP_ACTOR)
        reply.code(201)
        return { invoice }
      } catch (err) {
        reply.code(400)
        return {
          error: 'CREATE_INVOICE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    })
  }

  for (const url of bothPaths('/projects/:projectId/invoices/from-proposal')) {
    app.post(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = CreateFromProposalBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        const input: Parameters<typeof service.createInvoiceFromProposal>[0] = {
          projectId: params.data.projectId,
          proposalId: body.data.proposalId,
        }
        if (body.data.taxAmount !== undefined) input.taxAmount = body.data.taxAmount
        if (body.data.dueDate !== undefined) input.dueDate = body.data.dueDate
        if (body.data.notes !== undefined) input.notes = body.data.notes
        const invoice = service.createInvoiceFromProposal(input, HTTP_ACTOR)
        reply.code(201)
        return { invoice }
      } catch (err) {
        reply.code(400)
        return {
          error: 'FROM_PROPOSAL_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    })
  }

  // ── Cross-project list (P5P2) ─────────────────────────────────────────

  for (const url of bothPaths('/invoicing/invoices')) {
    app.get(url, async (req, reply) => {
      const parsed = ListInvoicesQuery.safeParse(req.query)
      if (!parsed.success) {
        reply.code(400)
        return { error: 'INVALID_QUERY', details: parsed.error.flatten() }
      }
      const q = parsed.data
      const opts: Parameters<typeof service.listInvoices>[0] = {}
      if (q.projectId) opts.projectId = q.projectId
      if (q.status) opts.status = asArr(q.status)
      if (q.syncStatus) opts.syncStatus = asArr(q.syncStatus)
      if (q.limit !== undefined) opts.limit = q.limit
      return { invoices: service.listInvoices(opts) }
    })
  }

  // ── Project-scoped list (legacy, still supported) ─────────────────────

  for (const url of bothPaths('/projects/:projectId/invoices')) {
    app.get(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      return { invoices: service.listInvoicesForProject(params.data.projectId) }
    })
  }

  for (const url of bothPaths('/projects/:projectId/budget')) {
    app.get(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      return { budget: service.getProjectBudget(params.data.projectId) }
    })
  }

  // ── Single invoice + edit ─────────────────────────────────────────────

  for (const url of bothPaths('/invoicing/invoices/:id')) {
    app.get(url, async (req, reply) => {
      const params = InvoiceIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const invoice = service.getInvoice(params.data.id)
      if (!invoice) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      const payments = service.listPayments(invoice.id)
      const drift =
        invoice.syncStatus === 'drift'
          ? {
              invoiceId: invoice.id,
              driftFields: invoice.driftFields,
              local: {
                number: invoice.number,
                total: invoice.total,
                balance: invoice.total - invoice.amountPaid,
                lineCount: invoice.lines.length,
                dueDate: invoice.dueDate,
              },
              qbo: invoice.qboPullSnapshot ?? {},
            }
          : null
      return { invoice, payments, drift }
    })

    app.patch(url, async (req, reply) => {
      const params = InvoiceIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = UpdateInvoiceBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        const input: Parameters<typeof service.updateInvoice>[1] = {}
        if (body.data.status !== undefined) input.status = body.data.status
        if (body.data.lines !== undefined) input.lines = body.data.lines
        if (body.data.taxAmount !== undefined) input.taxAmount = body.data.taxAmount
        if (body.data.dueDate !== undefined) input.dueDate = body.data.dueDate
        if (body.data.notes !== undefined) input.notes = body.data.notes
        if (body.data.metadata !== undefined) input.metadata = body.data.metadata
        const invoice = service.updateInvoice(params.data.id, input, HTTP_ACTOR)
        return { invoice }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.startsWith('Invoice not found')) {
          reply.code(404)
          return { error: 'NOT_FOUND' }
        }
        reply.code(400)
        return { error: 'UPDATE_FAILED', message: msg }
      }
    })
  }

  // ── Legacy aliases for tests (kept v1-shaped) ─────────────────────────

  for (const url of bothPaths('/invoices/:id')) {
    app.get(url, async (req, reply) => {
      const params = InvoiceIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const invoice = service.getInvoice(params.data.id)
      if (!invoice) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      return { invoice, payments: service.listPayments(invoice.id) }
    })
  }

  // ── Status transitions ────────────────────────────────────────────────

  for (const url of bothPaths('/invoices/:id/status')) {
    app.patch(url, async (req, reply) => {
      const params = InvoiceIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = PatchStatusBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        service.setInvoiceStatus(params.data.id, body.data.status, HTTP_ACTOR)
      } catch (err) {
        const mapped = mapDomainError(err)
        if (mapped) {
          reply.code(mapped.status)
          return mapped.body
        }
        throw err
      }
      return { invoice: service.getInvoice(params.data.id) }
    })
  }

  for (const url of bothPaths('/invoicing/invoices/:id/status')) {
    app.patch(url, async (req, reply) => {
      const params = InvoiceIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = PatchStatusBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        service.setInvoiceStatus(params.data.id, body.data.status, HTTP_ACTOR)
      } catch (err) {
        const mapped = mapDomainError(err)
        if (mapped) {
          reply.code(mapped.status)
          return mapped.body
        }
        throw err
      }
      return { invoice: service.getInvoice(params.data.id) }
    })
  }

  // ── Payments ──────────────────────────────────────────────────────────

  for (const url of bothPaths('/invoices/:id/payments')) {
    app.post(url, async (req, reply) => {
      const params = InvoiceIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = RecordPaymentBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        const input: Parameters<typeof service.recordPayment>[0] = {
          invoiceId: params.data.id,
          amount: body.data.amount,
        }
        if (body.data.receivedAt !== undefined) input.receivedAt = body.data.receivedAt
        if (body.data.method !== undefined) input.method = body.data.method
        if (body.data.reference !== undefined) input.reference = body.data.reference
        if (body.data.notes !== undefined) input.notes = body.data.notes
        const payment = service.recordPayment(input, HTTP_ACTOR)
        reply.code(201)
        return { payment, invoice: service.getInvoice(params.data.id) }
      } catch (err) {
        reply.code(400)
        return {
          error: 'RECORD_PAYMENT_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    })
  }

  for (const url of bothPaths('/invoicing/invoices/:id/payments')) {
    app.post(url, async (req, reply) => {
      const params = InvoiceIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = RecordPaymentBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        const input: Parameters<typeof service.recordPayment>[0] = {
          invoiceId: params.data.id,
          amount: body.data.amount,
        }
        if (body.data.receivedAt !== undefined) input.receivedAt = body.data.receivedAt
        if (body.data.method !== undefined) input.method = body.data.method
        if (body.data.reference !== undefined) input.reference = body.data.reference
        if (body.data.notes !== undefined) input.notes = body.data.notes
        const payment = service.recordPayment(input, HTTP_ACTOR)
        reply.code(201)
        return { payment, invoice: service.getInvoice(params.data.id) }
      } catch (err) {
        reply.code(400)
        return {
          error: 'RECORD_PAYMENT_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    })
  }

  // ── QBO sync (push / pull / reconcile) ────────────────────────────────

  function qboOrErr():
    | { ok: true; qbo: NonNullable<RegisterInvoicingRoutesDeps['qbo']> }
    | { ok: false } {
    if (!deps.qbo) return { ok: false }
    return { ok: true, qbo: deps.qbo }
  }

  async function withAuth(qbo: NonNullable<RegisterInvoicingRoutesDeps['qbo']>): Promise<
    | { ok: true; auth: { accessToken: string; realmId: string } }
    | { error: 'NOT_CONNECTED' }
  > {
    const conn = service.getQboConnection()
    if (!conn) return { error: 'NOT_CONNECTED' }
    if (conn.tokenExpiresAt <= Date.now()) {
      // Attempt a refresh inline; if refresh fails the caller treats it as
      // NOT_CONNECTED so the operator re-runs the OAuth flow.
      let refreshToken: string
      try {
        refreshToken = qbo.vault.decrypt(conn.refreshTokenEncrypted)
      } catch {
        return { error: 'NOT_CONNECTED' }
      }
      try {
        const tokens = await qbo.client.refreshTokens(refreshToken)
        service.upsertQboConnection(
          {
            realmId: conn.realmId,
            companyName: conn.companyName,
            accessTokenEncrypted: qbo.vault.encrypt(tokens.accessToken),
            refreshTokenEncrypted: qbo.vault.encrypt(tokens.refreshToken),
            tokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
          },
          HTTP_ACTOR,
        )
        return { ok: true, auth: { accessToken: tokens.accessToken, realmId: conn.realmId } }
      } catch {
        return { error: 'NOT_CONNECTED' }
      }
    }
    let accessToken: string
    try {
      accessToken = qbo.vault.decrypt(conn.accessTokenEncrypted)
    } catch {
      return { error: 'NOT_CONNECTED' }
    }
    return { ok: true, auth: { accessToken, realmId: conn.realmId } }
  }

  for (const url of bothPaths('/invoicing/invoices/:id/push')) {
    app.post(url, async (req, reply) => {
      const params = InvoiceIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = PushBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      const guard = qboOrErr()
      if (!guard.ok) {
        reply.code(503)
        return { error: 'QBO_NOT_CONFIGURED' }
      }
      const invoice = service.getInvoice(params.data.id)
      if (!invoice) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      if (invoice.status === 'draft') {
        reply.code(409)
        return { error: 'INVOICE_NOT_ISSUED' }
      }
      if (invoice.syncStatus === 'drift' && !body.data.force) {
        reply.code(409)
        return { error: 'DRIFT', message: 'Use reconcile, or pass force=true.' }
      }
      const authRes = await withAuth(guard.qbo)
      if ('error' in authRes) {
        reply.code(409)
        return { error: authRes.error }
      }
      const customerRef = { value: invoice.projectId, name: invoice.number }
      try {
        const existingRemote =
          invoice.qboId !== null
            ? await guard.qbo.client.getInvoice(authRes.auth, invoice.qboId)
            : null
        const doc = localToQbo(invoice, customerRef, existingRemote ?? undefined)
        const pushed = existingRemote
          ? await guard.qbo.client.updateInvoice(authRes.auth, doc)
          : await guard.qbo.client.createInvoice(authRes.auth, doc)
        const now = Date.now()
        const updated = service.recordQboPushed(
          invoice.id,
          { qboId: pushed.Id, qboDocNumber: pushed.DocNumber ?? null, ts: now },
          HTTP_ACTOR,
        )
        return {
          qboId: pushed.Id,
          syncStatus: 'synced' as const,
          lastSyncedAt: new Date(now).toISOString(),
          qboDocNumber: pushed.DocNumber,
          invoice: updated,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        service.markSyncFailed(invoice.id, { code: 'QBO_ERROR', message })
        service.recordQboError({ code: 'QBO_ERROR', message })
        reply.code(502)
        return { error: 'QBO_ERROR', qboMessage: message }
      }
    })
  }

  for (const url of bothPaths('/invoicing/invoices/:id/pull')) {
    app.post(url, async (req, reply) => {
      const params = InvoiceIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const guard = qboOrErr()
      if (!guard.ok) {
        reply.code(503)
        return { error: 'QBO_NOT_CONFIGURED' }
      }
      const invoice = service.getInvoice(params.data.id)
      if (!invoice) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      if (invoice.qboId === null) {
        reply.code(404)
        return { error: 'NOT_PUSHED' }
      }
      const authRes = await withAuth(guard.qbo)
      if ('error' in authRes) {
        reply.code(409)
        return { error: authRes.error }
      }
      try {
        const remote = await guard.qbo.client.getInvoice(authRes.auth, invoice.qboId)
        if (!remote) {
          reply.code(404)
          return { error: 'QBO_NOT_FOUND' }
        }
        const driftFields = detectDrift(invoice, remote)
        const now = Date.now()
        if (driftFields.length === 0) {
          const updated = service.recordQboPulled(
            invoice.id,
            { ts: now, driftFields: [], snapshot: null },
            HTTP_ACTOR,
          )
          return {
            syncStatus: 'synced' as const,
            lastSyncedAt: new Date(now).toISOString(),
            invoice: updated,
          }
        }
        const { qbo } = buildSnapshots(invoice, remote, driftFields)
        const updated = service.recordQboPulled(
          invoice.id,
          { ts: now, driftFields, snapshot: qbo },
          HTTP_ACTOR,
        )
        return {
          syncStatus: 'drift' as const,
          lastSyncedAt: new Date(now).toISOString(),
          driftFields,
          invoice: updated,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        service.markSyncFailed(invoice.id, { code: 'QBO_ERROR', message })
        service.recordQboError({ code: 'QBO_ERROR', message })
        reply.code(502)
        return { error: 'QBO_ERROR', qboMessage: message }
      }
    })
  }

  for (const url of bothPaths('/invoicing/invoices/:id/reconcile')) {
    app.post(url, async (req, reply) => {
      const params = InvoiceIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = ReconcileBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      const guard = qboOrErr()
      if (!guard.ok) {
        reply.code(503)
        return { error: 'QBO_NOT_CONFIGURED' }
      }
      const invoice = service.getInvoice(params.data.id)
      if (!invoice) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      if (invoice.syncStatus !== 'drift') {
        reply.code(409)
        return { error: 'NOT_IN_DRIFT' }
      }
      if (body.data.strategy === 'merge' && !body.data.merged) {
        reply.code(422)
        return { error: 'INVALID_MERGE' }
      }
      const authRes = await withAuth(guard.qbo)
      if ('error' in authRes) {
        reply.code(409)
        return { error: authRes.error }
      }
      const now = Date.now()
      try {
        if (body.data.strategy === 'accept_qbo') {
          // We accept QBO's view by clearing local drift; the snapshot
          // already represents QBO state.
          const updated = service.recordQboReconciled(
            invoice.id,
            { strategy: 'accept_qbo' },
            HTTP_ACTOR,
          )
          return {
            syncStatus: 'synced' as const,
            lastSyncedAt: new Date(now).toISOString(),
            resolution: 'accept_qbo' as const,
            invoice: updated,
          }
        }
        // For keep_local & merge we push local (post-merge) back to QBO.
        const customerRef = { value: invoice.projectId, name: invoice.number }
        const remote =
          invoice.qboId !== null
            ? await guard.qbo.client.getInvoice(authRes.auth, invoice.qboId)
            : null
        const doc = localToQbo(invoice, customerRef, remote ?? undefined)
        const pushed = remote
          ? await guard.qbo.client.updateInvoice(authRes.auth, doc)
          : await guard.qbo.client.createInvoice(authRes.auth, doc)
        const updated = service.recordQboReconciled(
          invoice.id,
          {
            strategy: body.data.strategy,
            pushResult: { qboId: pushed.Id, qboDocNumber: pushed.DocNumber ?? null },
          },
          HTTP_ACTOR,
        )
        return {
          syncStatus: 'synced' as const,
          lastSyncedAt: new Date(now).toISOString(),
          resolution: body.data.strategy,
          invoice: updated,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        service.markSyncFailed(invoice.id, { code: 'QBO_ERROR', message })
        service.recordQboError({ code: 'QBO_ERROR', message })
        reply.code(502)
        return { error: 'QBO_ERROR', qboMessage: message }
      }
    })
  }

  // ── QBO connection status ─────────────────────────────────────────────

  for (const url of bothPaths('/invoicing/qbo/status')) {
    app.get(url, async () => {
      const conn = service.getQboConnection()
      if (!conn) {
        return { connected: false }
      }
      return {
        connected: true,
        realmId: conn.realmId,
        companyName: conn.companyName,
        connectedAt: conn.connectedAt,
        tokenExpiresAt: conn.tokenExpiresAt,
        lastPushAt: conn.lastPushAt,
        lastPullAt: conn.lastPullAt,
        lastError: conn.lastError,
      }
    })
  }

  // ── OAuth: connect / callback / disconnect ───────────────────────────

  for (const url of bothPaths('/integrations/qbo/connect')) {
    app.get(url, async (_req, reply) => {
      if (!deps.qbo) {
        reply.code(503)
        return { error: 'QBO_NOT_CONFIGURED' }
      }
      const state = deps.qbo.oauthState.mint()
      const authorize = deps.qbo.authorizeUrl ?? DEFAULT_AUTHORIZE_URL
      const params = new URLSearchParams({
        client_id: deps.qbo.clientId,
        response_type: 'code',
        scope: 'com.intuit.quickbooks.accounting',
        redirect_uri: deps.qbo.redirectUri,
        state,
      })
      reply.code(302).header('location', `${authorize}?${params.toString()}`)
      return reply.send('')
    })
  }

  for (const url of bothPaths('/integrations/qbo/callback')) {
    app.get(url, async (req, reply) => {
      const q = (req.query as Record<string, string | undefined>) ?? {}
      const spaUrl = deps.qbo?.spaCallbackUrl ?? DEFAULT_SPA_CALLBACK

      if (!deps.qbo) {
        reply.code(503)
        return { error: 'QBO_NOT_CONFIGURED' }
      }
      if (typeof q.state !== 'string' || !deps.qbo.oauthState.consume(q.state)) {
        reply.code(302).header('location', `${spaUrl}&qbo=error&reason=bad_state`)
        return reply.send('')
      }
      if (q.error) {
        reply
          .code(302)
          .header(
            'location',
            `${spaUrl}&qbo=error&reason=${encodeURIComponent(q.error)}`,
          )
        return reply.send('')
      }
      if (typeof q.code !== 'string' || typeof q.realmId !== 'string') {
        reply.code(302).header('location', `${spaUrl}&qbo=error&reason=missing_code`)
        return reply.send('')
      }
      try {
        const tokens = await deps.qbo.client.exchangeCode(q.code, deps.qbo.redirectUri)
        const realmId = tokens.realmId ?? q.realmId
        const companyInfo = await deps.qbo.client
          .companyInfo({ accessToken: tokens.accessToken, realmId })
          .catch(() => null)
        service.upsertQboConnection(
          {
            realmId,
            companyName: companyInfo?.CompanyName ?? null,
            accessTokenEncrypted: deps.qbo.vault.encrypt(tokens.accessToken),
            refreshTokenEncrypted: deps.qbo.vault.encrypt(tokens.refreshToken),
            tokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
          },
          HTTP_ACTOR,
        )
        reply.code(302).header('location', `${spaUrl}&qbo=connected`)
        return reply.send('')
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        reply
          .code(302)
          .header(
            'location',
            `${spaUrl}&qbo=error&reason=${encodeURIComponent(reason)}`,
          )
        return reply.send('')
      }
    })
  }

  for (const url of bothPaths('/integrations/qbo/disconnect')) {
    app.post(url, async (_req, reply) => {
      const conn = service.getQboConnection()
      if (!conn) {
        reply.code(404)
        return { error: 'NOT_CONNECTED' }
      }
      if (deps.qbo) {
        // Best-effort revoke; swallow errors so the local row still clears.
        try {
          const refresh = deps.qbo.vault.decrypt(conn.refreshTokenEncrypted)
          await deps.qbo.client.revoke(refresh)
        } catch {
          // swallow
        }
      }
      service.clearQboConnection(HTTP_ACTOR)
      return { ok: true }
    })
  }

  // ── Download (markdown / PDF) ────────────────────────────────────────

  for (const url of bothPaths('/invoicing/invoices/:id/download/:format')) {
    app.get(url, async (req, reply) => {
      const params = z
        .object({ id: z.string().min(1), format: z.enum(['md', 'pdf']) })
        .safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const invoice = service.getInvoice(params.data.id)
      if (!invoice) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      const md = renderInvoiceMarkdown(invoice)
      if (params.data.format === 'md') {
        reply.header('content-type', 'text/markdown; charset=utf-8')
        return md
      }
      if (!pandocAvailable) {
        reply.code(503)
        return { error: 'PDF_UNAVAILABLE', reason: 'Pandoc not found on PATH' }
      }
      try {
        const pdfBuf = await renderPdfViaPandoc(md)
        reply.header('content-type', 'application/pdf')
        return pdfBuf
      } catch (err) {
        reply.code(500)
        return {
          error: 'PDF_RENDER_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    })
  }
}

function renderInvoiceMarkdown(invoice: {
  number: string
  status: InvoiceStatus
  subtotal: number
  taxAmount: number
  total: number
  amountPaid: number
  dueDate: number | null
  lines: Array<{ description: string; qty: number; unitPrice: number; lineTotal: number }>
  notes: string | null
}): string {
  const lines: string[] = []
  lines.push(`# Invoice ${escapeBlock(invoice.number)}`)
  lines.push('')
  lines.push(`**Status:** ${projectionStatus(invoice.status)}`)
  if (invoice.dueDate !== null) {
    lines.push(`**Due:** ${new Date(invoice.dueDate).toISOString().slice(0, 10)}`)
  }
  lines.push('')
  lines.push('| Description | Qty | Unit price | Total |')
  lines.push('|---|---:|---:|---:|')
  for (const l of invoice.lines) {
    lines.push(
      `| ${escapeTableCell(l.description)} | ${escapeTableCell(l.qty)} | ${l.unitPrice.toFixed(2)} | ${l.lineTotal.toFixed(2)} |`,
    )
  }
  lines.push('')
  lines.push(`Subtotal: ${invoice.subtotal.toFixed(2)}`)
  lines.push(`Tax: ${invoice.taxAmount.toFixed(2)}`)
  lines.push(`Total: ${invoice.total.toFixed(2)}`)
  lines.push(`Amount paid: ${invoice.amountPaid.toFixed(2)}`)
  lines.push(`Balance: ${(invoice.total - invoice.amountPaid).toFixed(2)}`)
  if (invoice.notes) {
    lines.push('')
    lines.push(escapeBlock(invoice.notes))
  }
  return lines.join('\n')
}

async function renderPdfViaPandoc(md: string): Promise<Buffer> {
  // Use a markdown variant that disables raw HTML + raw TeX, so any
  // user-supplied notes/descriptions cannot smuggle in raw constructs.
  // The escape helpers already neutralise the leading characters; this is
  // defence in depth.
  const result = await renderPandoc({
    input: Buffer.from(md, 'utf-8'),
    to: 'pdf',
    extraArgs: pandocSafeInputArgs('markdown'),
  })
  if (result.kind === 'ok') return result.output
  if (result.kind === 'timeout') {
    throw new Error(`pandoc timed out (stderr: ${result.stderr.slice(0, 200)})`)
  }
  if (result.kind === 'spawn_failed') {
    throw new Error(`pandoc spawn failed: ${result.error}`)
  }
  throw new Error(
    `pandoc exit ${result.exitCode ?? 'unknown'} (stderr: ${result.stderr.slice(0, 200)})`,
  )
}

// Prevent dead-code elim warnings — these are imported for symmetry with
// proposals/routes; the download path uses renderPandoc above.
void [isAbsolute, resolve, basename, readdir, readFile, stat, execFileAsync, execFile]

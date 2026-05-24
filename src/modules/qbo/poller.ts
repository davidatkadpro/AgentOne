import type { InvoicingService } from '../../../modules/invoicing/src/service.js'
import type { SecretVault } from '../../storage/secret-vault.js'
import type { QboHttpClient } from './source.js'
import { detectDrift, buildSnapshots } from './pull.js'

export interface QboPollerOptions {
  service: InvoicingService
  client: QboHttpClient
  vault: SecretVault
  /** Interval in ms (default 15 min). */
  intervalMs?: number
  /** Optional now-override (test-only). */
  now?: () => number
}

/**
 * Background poll loop: for every locally-pushed invoice (`qbo_id` populated),
 * fetch the QBO doc and update sync_status accordingly. Pauses when the
 * connection is missing or its tokens have expired.
 *
 * The loop is fire-and-forget; failures are swallowed so a transient QBO
 * outage doesn't crash the host process.
 */
export class QboPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private intervalMs: number

  constructor(private opts: QboPollerOptions) {
    this.intervalMs = opts.intervalMs ?? 15 * 60_000
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    // Allow the process to exit even if the timer is still scheduled.
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
    const conn = this.opts.service.getQboConnection()
    if (!conn) return
    const now = (this.opts.now ?? Date.now)()
    if (conn.tokenExpiresAt <= now) {
      // Expired — push UI will surface the reconnect banner. Skip pulls.
      return
    }
    let accessToken: string
    try {
      accessToken = this.opts.vault.decrypt(conn.accessTokenEncrypted)
    } catch {
      return
    }
    const auth = { accessToken, realmId: conn.realmId }
    const all = this.opts.service.listInvoices()
    const candidates = all.filter((inv) => inv.qboId !== null)
    for (const invoice of candidates) {
      try {
        const remote = await this.opts.client.getInvoice(auth, invoice.qboId as string)
        if (!remote) continue
        const driftFields = detectDrift(invoice, remote)
        if (driftFields.length === 0) {
          this.opts.service.markPullResult(invoice.id, {
            driftFields: [],
            snapshot: null,
          })
        } else {
          const { qbo } = buildSnapshots(invoice, remote, driftFields)
          this.opts.service.markPullResult(invoice.id, {
            driftFields,
            snapshot: qbo,
          })
        }
        this.opts.service.recordQboPullTs(now)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.opts.service.markSyncFailed(invoice.id, {
          code: 'QBO_ERROR',
          message,
        })
        this.opts.service.recordQboError({ code: 'QBO_ERROR', message })
      }
    }
  }
}

import { z } from 'zod'
import type { ToolHandler } from '../../../../../src/skills/tool.js'
import { fail, ok } from '../../../../../src/skills/tool.js'
import type { InvoicingService } from '../../../src/service.js'

export const parameters = z.object({
  invoice_id: z.string().min(1),
  strategy: z.enum(['keep_local', 'accept_qbo', 'merge']),
  /** Required when strategy='merge'. Per-field selection map keyed by drift
   *  field path; the values are the actual chosen values to commit. */
  merged: z.record(z.unknown()).optional(),
})

/**
 * Server-side wrapper around `POST /api/invoicing/invoices/:id/reconcile` —
 * but we don't want the skill to depend on the HTTP layer being reachable
 * from inside its own process. We call the service directly for `accept_qbo`
 * (which is purely a local state clear) and surface `keep_local`/`merge` as a
 * not-yet-supported error since they require the QBO HTTP client, which the
 * skill runtime doesn't currently have access to. The operator can still use
 * the UI button to drive those strategies.
 */
export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const handle = ctx.services.modules.get('invoicing')
  if (!handle?.service) {
    return fail('RESOURCE_UNAVAILABLE', 'invoicing module is not active', false)
  }
  const service = handle.service as InvoicingService
  const invoice = service.getInvoice(args.invoice_id)
  if (!invoice) {
    return fail('TOOL_VALIDATION', `Invoice ${args.invoice_id} not found`, true)
  }
  if (invoice.syncStatus !== 'drift') {
    return fail('TOOL_VALIDATION', `Invoice is not in drift (status: ${invoice.syncStatus})`, true)
  }
  if (args.strategy === 'accept_qbo') {
    const out = service.recordQboReconciled(
      args.invoice_id,
      { strategy: 'accept_qbo' },
      { actor: { type: 'agent', sessionId: ctx.sessionId } },
    )
    return ok({
      invoice_id: out.id,
      resolution: 'accept_qbo',
      sync_status: out.syncStatus,
    })
  }
  // keep_local + merge require a QBO push, which goes through the HTTP layer
  // (the agent doesn't have an injected QBO client). Tell the operator to
  // click the button in the UI.
  return fail(
    'RESOURCE_UNAVAILABLE',
    `Strategy "${args.strategy}" requires a live QBO push. Use the side-by-side button in the UI.`,
    true,
  )
}

export default { parameters, handler }

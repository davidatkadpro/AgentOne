import type { FastifyInstance } from 'fastify'
import type { Orchestrator } from '../../../src/orchestrator/turn.js'
import type { EventBus } from '../../../src/core/events.js'
import { registerModuleActionDispatch } from '../../../src/modules/action-dispatch.js'
import type { InvoicingService } from './service.js'

/**
 * Invoicing-specific dispatch wiring. Resolves the entity as an Invoice row;
 * the project id is exposed inside the scope but the canonical contextId is
 * the invoice id. Discovery is registered globally per ADR-0007.
 */

export interface RegisterInvoicingActionsDeps {
  orchestrator: Orchestrator
  invoicing: InvoicingService
  /** Absolute path to `modules/invoicing/skills/`. */
  skillsDir: string
  eventBus?: EventBus
}

export async function registerInvoicingActions(
  app: FastifyInstance,
  deps: RegisterInvoicingActionsDeps,
): Promise<void> {
  type Invoice = NonNullable<ReturnType<InvoicingService['getInvoice']>>
  await registerModuleActionDispatch<Invoice>(app, {
    module: 'invoicing',
    urls: ['/api/v1/invoicing/actions', '/api/invoicing/actions'],
    skillsDir: deps.skillsDir,
    orchestrator: deps.orchestrator,
    lookup: (contextId) => deps.invoicing.getInvoice(contextId) ?? null,
    notFoundError: 'INVOICE_NOT_FOUND',
    scopeBuilder: (invoice, contextId, args) => ({
      invoice: {
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        projectId: invoice.projectId,
        total: invoice.total,
        balance: invoice.total - invoice.amountPaid,
        syncStatus: invoice.syncStatus,
      },
      contextId,
      args,
    }),
  })
}

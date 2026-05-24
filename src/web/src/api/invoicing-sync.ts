import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type {
  PullInvoiceResponse,
  PushInvoiceRequest,
  PushInvoiceResponse,
  ReconcileRequest,
  ReconcileResponse,
} from '@/types/api'

function showQboError(err: unknown, fallback: string): void {
  // Surface upstream QBO error message when available so the operator can act.
  const msg = err instanceof Error ? err.message : String(err)
  toast.error(`${fallback}: ${msg}`)
}

export function usePushInvoice(invoiceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: PushInvoiceRequest = {}) =>
      api.post<PushInvoiceResponse>(`/invoicing/invoices/${invoiceId}/push`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.detail(invoiceId) })
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      void qc.invalidateQueries({ queryKey: queryKeys.qbo.status() })
      toast.success('Pushed to QBO')
    },
    onError: (err) => showQboError(err, 'QBO push failed'),
  })
}

export function usePullInvoice(invoiceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<PullInvoiceResponse>(`/invoicing/invoices/${invoiceId}/pull`, {}),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.detail(invoiceId) })
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      void qc.invalidateQueries({ queryKey: queryKeys.qbo.status() })
      if (res.syncStatus === 'drift') {
        toast.warning('Drift detected — review the side-by-side and resolve.')
      } else {
        toast.success('Pulled — in sync with QBO')
      }
    },
    onError: (err) => showQboError(err, 'QBO pull failed'),
  })
}

export function useReconcileInvoice(invoiceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ReconcileRequest) =>
      api.post<ReconcileResponse>(`/invoicing/invoices/${invoiceId}/reconcile`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.detail(invoiceId) })
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      toast.success('Drift resolved')
    },
    onError: (err) => showQboError(err, 'Reconcile failed'),
  })
}

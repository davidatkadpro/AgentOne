import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type {
  CreateInvoiceFromProposalRequest,
  CreateInvoiceFromProposalResponse,
  CreateInvoiceRequest,
  CreateInvoiceResponse,
  InvoiceDetailResponse,
  ListInvoicesQuery,
  ListInvoicesResponse,
  ProjectBudgetResponse,
  RecordPaymentRequest,
  RecordPaymentResponse,
  UpdateInvoiceRequest,
  UpdateInvoiceResponse,
} from '@/types/api'

function buildInvoiceQs(opts: ListInvoicesQuery | undefined): string {
  if (!opts) return ''
  const sp = new URLSearchParams()
  if (opts.projectId) sp.set('projectId', opts.projectId)
  if (opts.limit !== undefined) sp.set('limit', String(opts.limit))
  if (opts.status !== undefined) {
    const arr = Array.isArray(opts.status) ? opts.status : [opts.status]
    for (const s of arr) sp.append('status', s)
  }
  if (opts.syncStatus !== undefined) {
    const arr = Array.isArray(opts.syncStatus) ? opts.syncStatus : [opts.syncStatus]
    for (const s of arr) sp.append('syncStatus', s)
  }
  const qs = sp.toString()
  return qs ? `?${qs}` : ''
}

export function useInvoices(opts?: ListInvoicesQuery) {
  return useQuery({
    queryKey: queryKeys.invoices.list(opts as Record<string, unknown> | undefined),
    queryFn: () =>
      api
        .get<ListInvoicesResponse>(`/invoicing/invoices${buildInvoiceQs(opts)}`)
        .then((r) => r.invoices),
  })
}

export function useInvoice(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.invoices.detail(id ?? ''),
    queryFn: () => api.get<InvoiceDetailResponse>(`/invoicing/invoices/${id}`),
    enabled: !!id,
  })
}

export function useCreateInvoice(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateInvoiceRequest) =>
      api.post<CreateInvoiceResponse>(`/projects/${projectId}/invoices`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.budget(projectId) })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
    },
    onError: (err) => {
      toast.error(`Create invoice failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
}

export function useCreateInvoiceFromProposal(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateInvoiceFromProposalRequest) =>
      api.post<CreateInvoiceFromProposalResponse>(
        `/projects/${projectId}/invoices/from-proposal`,
        body,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.budget(projectId) })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
    },
    onError: (err) => {
      toast.error(
        `From-proposal failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    },
  })
}

export function useUpdateInvoice(invoiceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateInvoiceRequest) =>
      api.patch<UpdateInvoiceResponse>(`/invoicing/invoices/${invoiceId}`, body),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.detail(invoiceId) })
      void qc.invalidateQueries({
        queryKey: queryKeys.projects.budget(data.invoice.projectId),
      })
    },
    onError: (err) => {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.detail(invoiceId) })
    },
  })
}

export function useRecordPayment(invoiceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: RecordPaymentRequest) =>
      api.post<RecordPaymentResponse>(`/invoicing/invoices/${invoiceId}/payments`, body),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.detail(invoiceId) })
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      void qc.invalidateQueries({
        queryKey: queryKeys.projects.budget(data.invoice.projectId),
      })
    },
    onError: (err) => {
      toast.error(`Record payment failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
}

export function useProjectBudget(projectId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.projects.budget(projectId ?? ''),
    queryFn: () =>
      api
        .get<ProjectBudgetResponse>(`/projects/${projectId}/budget`)
        .then((r) => r.budget),
    enabled: !!projectId,
  })
}

export function downloadInvoiceUrl(invoiceId: string, format: 'md' | 'pdf'): string {
  return `/api/invoicing/invoices/${invoiceId}/download/${format}`
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type {
  EmailBodyResponse,
  EmailDetailResponse,
  ListEmailsQuery,
  ListEmailsResponse,
  PollEmailResponse,
  UpdateEmailRequest,
  UpdateEmailResponse,
} from '@/types/api'

function buildEmailQs(opts: ListEmailsQuery): string {
  const params = new URLSearchParams()
  if (opts.isRead !== undefined) params.set('isRead', String(opts.isRead))
  if (opts.filed !== undefined) params.set('filed', String(opts.filed))
  if (opts.hasAttachments !== undefined) params.set('hasAttachments', String(opts.hasAttachments))
  if (opts.projectId !== undefined) params.set('projectId', opts.projectId)
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  return params.size > 0 ? `?${params.toString()}` : ''
}

export function useEmails(opts: ListEmailsQuery = {}) {
  return useQuery({
    queryKey: queryKeys.emails.list(opts as Record<string, unknown>),
    queryFn: () => api.get<ListEmailsResponse>(`/email${buildEmailQs(opts)}`).then((r) => r.emails),
  })
}

export function useEmail(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.emails.detail(id ?? ''),
    queryFn: () => api.get<EmailDetailResponse>(`/email/${id}`),
    enabled: !!id,
  })
}

export function useEmailBody(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.emails.body(id ?? ''),
    queryFn: () => api.get<EmailBodyResponse>(`/email/${id}/body`),
    enabled: !!id,
    staleTime: 5 * 60_000,
  })
}

export function useMarkRead(emailId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateEmailRequest) =>
      api.patch<UpdateEmailResponse>(`/email/${emailId}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.emails.all() })
      void qc.invalidateQueries({ queryKey: queryKeys.emails.detail(emailId) })
    },
  })
}

export function usePollEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<PollEmailResponse>('/email/poll'),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: queryKeys.emails.all() })
      toast.success(`Polled inbox — ${res.ingested} new`)
    },
    onError: (err) => {
      toast.error(`Poll failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
}

export function attachmentUrl(emailId: string, filename: string): string {
  return `/api/email/${emailId}/attachments/${encodeURIComponent(filename)}`
}

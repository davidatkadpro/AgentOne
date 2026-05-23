import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type {
  CreateEstimateRequest,
  CreateEstimateResponse,
  CreateProposalRequest,
  CreateProposalResponse,
  ListArtifactsQuery,
  ListArtifactsResponse,
  ListScopeFilesResponse,
  ListTemplatesResponse,
  ProposalDetailResponse,
  ProposalHistoryResponse,
  RenderProposalRequest,
  RenderProposalResponse,
  ReviseEstimateResponse,
  UpdateEstimateRequest,
  UpdateEstimateResponse,
  UpdateProposalRequest,
  UpdateProposalResponse,
} from '@/types/api'

function buildArtifactsQs(opts: ListArtifactsQuery | undefined): string {
  if (!opts) return ''
  const sp = new URLSearchParams()
  if (opts.projectId) sp.set('projectId', opts.projectId)
  if (opts.search) sp.set('search', opts.search)
  if (opts.limit !== undefined) sp.set('limit', String(opts.limit))
  if (opts.status !== undefined) {
    const arr = Array.isArray(opts.status) ? opts.status : [opts.status]
    for (const s of arr) sp.append('status', s)
  }
  const qs = sp.toString()
  return qs ? `?${qs}` : ''
}

export function useArtifacts(opts?: ListArtifactsQuery) {
  return useQuery({
    queryKey: queryKeys.proposals.artifacts(opts as Record<string, unknown> | undefined),
    queryFn: () =>
      api.get<ListArtifactsResponse>(`/proposals/artifacts${buildArtifactsQs(opts)}`).then(
        (r) => r.artifacts,
      ),
  })
}

export function useProposalDetail(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.proposals.detail(id ?? ''),
    queryFn: () => api.get<ProposalDetailResponse>(`/proposals/${id}`),
    enabled: !!id,
  })
}

export function useProposalHistory(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.proposals.history(id ?? ''),
    queryFn: () => api.get<ProposalHistoryResponse>(`/proposals/${id}/history`),
    enabled: !!id,
  })
}

export function useProposalTemplates() {
  return useQuery({
    queryKey: queryKeys.proposals.templates(),
    queryFn: () =>
      api.get<ListTemplatesResponse>('/proposals/templates').then((r) => r.templates),
    staleTime: 5 * 60_000,
  })
}

export function useScopeFiles(projectId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.proposals.scopeFiles(projectId ?? ''),
    queryFn: () =>
      api.get<ListScopeFilesResponse>(`/projects/${projectId}/scope-files`).then((r) => r.files),
    enabled: !!projectId,
    staleTime: 30_000,
  })
}

export function useCreateEstimate(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateEstimateRequest) =>
      api.post<CreateEstimateResponse>(`/projects/${projectId}/estimates`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.proposals.all() })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
    },
    onError: (err) => {
      toast.error(`Create estimate failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
}

export function useUpdateEstimate(estimateId: string, detailIdForCache?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateEstimateRequest) =>
      api.patch<UpdateEstimateResponse>(`/estimates/${estimateId}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.proposals.all() })
      void qc.invalidateQueries({ queryKey: queryKeys.estimates.detail(estimateId) })
      if (detailIdForCache) {
        void qc.invalidateQueries({ queryKey: queryKeys.proposals.detail(detailIdForCache) })
      }
    },
    onError: (err) => {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
      // Snap back to server truth.
      if (detailIdForCache) {
        void qc.invalidateQueries({ queryKey: queryKeys.proposals.detail(detailIdForCache) })
      }
    },
  })
}

export function useReviseEstimate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (estimateId: string) =>
      api.post<ReviseEstimateResponse>(`/estimates/${estimateId}/revise`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.proposals.all() })
    },
    onError: (err) => {
      toast.error(`Revise failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
}

export function useCreateProposal(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateProposalRequest) =>
      api.post<CreateProposalResponse>(`/projects/${projectId}/proposals`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.proposals.all() })
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) })
    },
    onError: (err) => {
      toast.error(`Create proposal failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
}

export function useUpdateProposal(proposalId: string, detailIdForCache?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateProposalRequest) =>
      api.patch<UpdateProposalResponse>(`/proposals/${proposalId}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.proposals.all() })
      if (detailIdForCache) {
        void qc.invalidateQueries({ queryKey: queryKeys.proposals.detail(detailIdForCache) })
      }
    },
    onError: (err) => {
      toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
}

export function useRenderProposal(proposalId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: RenderProposalRequest) =>
      api.post<RenderProposalResponse>(`/proposals/${proposalId}/render`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.proposals.detail(proposalId) })
    },
  })
}

export function downloadProposalUrl(proposalId: string, format: 'md' | 'pdf' | 'docx'): string {
  return `/api/proposals/${proposalId}/download/${format}`
}

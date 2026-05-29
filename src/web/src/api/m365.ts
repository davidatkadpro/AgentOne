import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type { M365StatusResponse } from '@/types/api'

export function useM365Status() {
  return useQuery({
    queryKey: queryKeys.m365.status(),
    queryFn: () => api.get<M365StatusResponse>('/email/m365/status'),
    staleTime: 30_000,
  })
}

export function useDisconnectM365() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>('/integrations/m365/disconnect', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.m365.status() })
      void qc.invalidateQueries({ queryKey: queryKeys.emails.all() })
      toast.success('Microsoft 365 disconnected')
    },
    onError: (err) => {
      toast.error(`Disconnect failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
}

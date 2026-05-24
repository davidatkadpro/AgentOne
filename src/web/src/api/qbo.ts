import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type { QboStatusResponse } from '@/types/api'

export function useQboStatus() {
  return useQuery({
    queryKey: queryKeys.qbo.status(),
    queryFn: () => api.get<QboStatusResponse>('/invoicing/qbo/status'),
    staleTime: 30_000,
  })
}

export function useDisconnectQbo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: true }>('/integrations/qbo/disconnect', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.qbo.status() })
      void qc.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      toast.success('QBO disconnected')
    },
    onError: (err) => {
      toast.error(`Disconnect failed: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
}

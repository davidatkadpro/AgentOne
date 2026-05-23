import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type { ListDraftsResponse } from '@/types/api'

export function useDrafts() {
  return useQuery({
    queryKey: queryKeys.drafts.list(),
    queryFn: () => api.get<ListDraftsResponse>('/drafts').then((r) => r.drafts),
  })
}

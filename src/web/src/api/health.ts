import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type { HealthResponse } from '@/types/domain'

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health(),
    queryFn: () => api.get<HealthResponse>('/health'),
    staleTime: 60_000,
  })
}

import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type {
  ListModuleActionsResponse,
  DispatchModuleActionRequest,
  DispatchModuleActionResponse,
} from '@/types/api'

export function useModuleActions(moduleName: string) {
  return useQuery({
    queryKey: queryKeys.moduleActions.list(moduleName),
    queryFn: () => api.get<ListModuleActionsResponse>(`/${moduleName}/actions`),
    // 404 is fine — modules without an action surface aren't an error
    retry: false,
  })
}

export function useDispatchAction(moduleName: string) {
  return useMutation({
    mutationFn: (body: DispatchModuleActionRequest) =>
      api.post<DispatchModuleActionResponse>(`/${moduleName}/actions`, body),
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Action failed: ${msg}`)
    },
  })
}

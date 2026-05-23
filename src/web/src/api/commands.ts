import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import type { ListCommandsResponse, RunCommandRequest, RunCommandResponse } from '@/types/api'

export function useCommands() {
  return useQuery({
    queryKey: queryKeys.commands.list(),
    queryFn: () => api.get<ListCommandsResponse>('/commands').then((r) => r.commands),
  })
}

export function useRunCommand(sessionId: string) {
  return useMutation({
    mutationFn: (body: RunCommandRequest) =>
      api.post<RunCommandResponse>(`/sessions/${sessionId}/command`, body),
  })
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import { useSessionStreamStore } from '@/stores/session-stream'
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  CancelTurnResponse,
  ListSessionsResponse,
  SessionDetailResponse,
  SendMessageRequest,
  SendMessageResponse,
  RenameSessionRequest,
  RenameSessionResponse,
} from '@/types/api'

export function useSessions() {
  return useQuery({
    queryKey: queryKeys.sessions.list(),
    queryFn: () => api.get<ListSessionsResponse>('/sessions').then((r) => r.sessions),
  })
}

export function useSession(id: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(id ?? ''),
    queryFn: async () => {
      if (!id) throw new Error('Session id required')
      const data = await api.get<SessionDetailResponse>(`/sessions/${id}`)
      useSessionStreamStore.getState().hydrateFromDetail(id, data)
      return data
    },
    enabled: !!id,
  })
}

export function useCreateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateSessionRequest) =>
      api.post<CreateSessionResponse>('/sessions', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions.list() })
    },
  })
}

export function useSendMessage(sessionId: string) {
  return useMutation({
    mutationFn: (body: SendMessageRequest) => {
      const placeholderId = `optimistic-${Math.random().toString(36).slice(2, 10)}`
      useSessionStreamStore.getState().optimisticAppendUser(sessionId, body.text, placeholderId)
      return api
        .post<SendMessageResponse>(`/sessions/${sessionId}/messages`, body)
        .catch((err) => {
          useSessionStreamStore.getState().removeOptimistic(sessionId, placeholderId)
          throw err
        })
    },
    onSuccess: () => {
      // A successful POST means the profile mismatch (if any) was resolved
      // — clear the banner so the composer doesn't stay disabled forever.
      useSessionStreamStore.getState().clearProfileMismatch(sessionId)
    },
  })
}

export function useCancelTurn(sessionId: string) {
  return useMutation({
    mutationFn: () => api.post<CancelTurnResponse>(`/sessions/${sessionId}/cancel`),
  })
}

export function useRenameSession(sessionId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: RenameSessionRequest) =>
      api.patch<RenameSessionResponse>(`/sessions/${sessionId}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions.list() })
      void qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) })
    },
  })
}

export function useArchiveSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      // Loop client-side. Each PATCH is small; no bulk endpoint yet.
      await Promise.all(
        ids.map((id) =>
          api.patch<RenameSessionResponse>(`/sessions/${id}`, { state: 'archived' }),
        ),
      )
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions.list() })
    },
  })
}

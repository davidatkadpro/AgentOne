import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-client'
import { useNotificationsStore } from '@/stores/notifications'
import type {
  ListNotificationsResponse,
  UpdateNotificationRequest,
  UpdateNotificationResponse,
  AnswerNotificationRequest,
  AnswerNotificationResponse,
} from '@/types/api'

export function useNotifications(opts?: { includeResolved?: boolean }) {
  const includeResolved = !!opts?.includeResolved
  const q = useQuery({
    queryKey: queryKeys.notifications.list({ includeResolved }),
    queryFn: () =>
      api
        .get<ListNotificationsResponse>(
          `/notifications${includeResolved ? '?includeResolved=true' : ''}`,
        )
        .then((r) => r.notifications),
  })
  // Reconcile the unresolved-attention count with the source of truth.
  useEffect(() => {
    if (!q.data) return
    const count = q.data.filter(
      (n) => n.kind === 'attention_needed' && (n.status === 'unread' || n.status === 'read'),
    ).length
    useNotificationsStore.getState().reconcileCount(count)
  }, [q.data])
  return q
}

export function useUpdateNotification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; body: UpdateNotificationRequest }) =>
      api.patch<UpdateNotificationResponse>(`/notifications/${input.id}`, input.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.notifications.all() })
    },
  })
}

export function useAnswerNotification(sessionId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { notifId: number; body: AnswerNotificationRequest }) =>
      api.post<AnswerNotificationResponse>(
        `/sessions/${sessionId}/notifications/${input.notifId}/answer`,
        input.body,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.notifications.all() })
    },
  })
}

import { useEffect } from 'react'
import { parseAgentEvent, type AgentEvent } from '@/types/events'
import { nextReconnectDelayMs } from './ws-backoff'
import { useWsStore, subscribedSessions } from '@/stores/ws'
import { useSessionStreamStore } from '@/stores/session-stream'
import { useNotificationsStore } from '@/stores/notifications'
import { useEmailChipsStore } from '@/stores/email-chips'
import { queryClient, queryKeys } from './query-client'
import { getAuthToken } from './auth-token'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

export function invalidateForEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'session.created':
    case 'session.spawned':
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.list() })
      break
    case 'session.titled':
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.list() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(event.sessionId) })
      break
    case 'session.auto_distilled':
      void queryClient.invalidateQueries({ queryKey: queryKeys.drafts.list() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() })
      break
    case 'notification.created':
    case 'notification.updated':
    case 'notification.resolved':
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() })
      break
    case 'drafts.pruned':
      void queryClient.invalidateQueries({ queryKey: queryKeys.drafts.list() })
      break
    case 'skill.loaded':
    case 'skill.load_failed':
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills.list() })
      break
    case 'module.reloaded':
      void queryClient.invalidateQueries({
        queryKey: queryKeys.moduleActions.list(event.module),
      })
      break
    case 'project.created':
    case 'project.updated':
    case 'project.completed':
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.list() })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(event.projectId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.activity(event.projectId),
      })
      break
    case 'phase.created':
    case 'phase.completed':
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(event.projectId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.activity(event.projectId),
      })
      break
    case 'task.created':
    case 'task.updated':
    case 'task.completed':
    case 'task.blocked':
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(event.projectId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.activity(event.projectId),
      })
      break
    case 'email.received':
      void queryClient.invalidateQueries({ queryKey: queryKeys.emails.all() })
      break
    case 'email.read':
      void queryClient.invalidateQueries({ queryKey: queryKeys.emails.all() })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.emails.detail(event.emailId),
      })
      break
    case 'email.filed':
      void queryClient.invalidateQueries({ queryKey: queryKeys.emails.all() })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.emails.detail(event.emailId),
      })
      if (event.projectId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.projects.detail(event.projectId),
        })
        void queryClient.invalidateQueries({
          queryKey: queryKeys.projects.activity(event.projectId),
        })
      }
      break
    case 'estimate.created':
    case 'estimate.updated':
    case 'estimate.accepted':
    case 'estimate.rejected':
      void queryClient.invalidateQueries({ queryKey: queryKeys.proposals.all() })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.estimates.detail(event.estimateId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(event.projectId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.activity(event.projectId),
      })
      break
    case 'proposal.created':
    case 'proposal.issued':
    case 'proposal.accepted':
    case 'proposal.rejected':
    case 'proposal.superseded':
      void queryClient.invalidateQueries({ queryKey: queryKeys.proposals.all() })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.proposals.detail(event.proposalId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(event.projectId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.activity(event.projectId),
      })
      break
    case 'invoice.created':
    case 'invoice.issued':
    case 'invoice.paid':
    case 'invoice.voided':
      void queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.invoices.detail(event.invoiceId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(event.projectId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.budget(event.projectId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.activity(event.projectId),
      })
      break
    case 'payment.recorded':
      void queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.invoices.detail(event.invoiceId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.budget(event.projectId),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.activity(event.projectId),
      })
      break
    case 'qbo.invoice_pushed':
    case 'qbo.invoice_pulled':
    case 'qbo.drift_detected':
    case 'qbo.sync_failed':
      void queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.invoices.detail(event.invoiceId),
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.qbo.status() })
      break
    case 'qbo.connected':
    case 'qbo.disconnected':
      void queryClient.invalidateQueries({ queryKey: queryKeys.qbo.status() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all() })
      break
  }
}

type SessionDetail = Parameters<ReturnType<typeof useSessionStreamStore.getState>['hydrateFromDetail']>[1]

function resyncAfterReconnect(): void {
  // Invalidate session detail for every subscribed session, then re-hydrate.
  for (const sessionId of subscribedSessions()) {
    void queryClient
      .invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) })
      .then(() =>
        queryClient.fetchQuery<SessionDetail>({
          queryKey: queryKeys.sessions.detail(sessionId),
        }),
      )
      .then((detail) => {
        if (detail) {
          useSessionStreamStore.getState().hydrateFromDetail(sessionId, detail)
        }
      })
      .catch(() => {
        // best-effort; the next user interaction will trigger a fresh fetch
      })
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() })
}

export function connectWebSocket(): void {
  if (typeof window === 'undefined') return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const store = useWsStore.getState()
  const wasReconnecting = store.status === 'reconnecting' || store.reconnectAttempts > 0
  store.setStatus(store.reconnectAttempts > 0 ? 'reconnecting' : 'connecting')
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const token = getAuthToken()
  // WS upgrades cannot set custom headers from browsers, so we append
  // ?token= to the URL; the auth gate accepts either form.
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : ''
  const url = `${proto}://${window.location.host}/ws${tokenQuery}`
  try {
    ws = new WebSocket(url)
  } catch {
    scheduleReconnect()
    return
  }
  ws.addEventListener('open', () => {
    useWsStore.getState().setStatus('open')
    useWsStore.getState().setAttempts(0)
    // Re-subscribe to all sessions the app cared about before the drop.
    for (const sessionId of subscribedSessions()) {
      ws?.send(JSON.stringify({ op: 'subscribe', sessionId }))
    }
    if (wasReconnecting) {
      resyncAfterReconnect()
    }
  })
  ws.addEventListener('message', (ev) => {
    let raw: unknown
    try {
      raw = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
    } catch {
      return
    }
    const parsed = parseAgentEvent(raw)
    if (!parsed) return
    useSessionStreamStore.getState().applyEvent(parsed)
    useNotificationsStore.getState().applyEvent(parsed)
    useEmailChipsStore.getState().applyEvent(parsed)
    invalidateForEvent(parsed)
  })
  ws.addEventListener('close', () => {
    scheduleReconnect()
  })
  ws.addEventListener('error', () => {
    // The close handler will fire next; nothing to do here.
  })
}

function scheduleReconnect(): void {
  if (typeof window === 'undefined') return
  const store = useWsStore.getState()
  const attempts = store.reconnectAttempts
  store.setStatus('reconnecting')
  store.setAttempts(attempts + 1)
  const delay = nextReconnectDelayMs(attempts)
  reconnectTimer = setTimeout(connectWebSocket, delay)
}

function subscribe(sessionId: string): void {
  const count = useWsStore.getState().incRef(sessionId)
  if (count === 1 && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ op: 'subscribe', sessionId }))
  }
}

function unsubscribe(sessionId: string): void {
  const remaining = useWsStore.getState().decRef(sessionId)
  if (remaining === 0 && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ op: 'unsubscribe', sessionId }))
  }
}

/**
 * The only consumer-facing API for WS subscriptions. Reference-counted so
 * multiple components subscribing to the same session don't step on each
 * other. Components MUST NOT call subscribe/unsubscribe directly.
 */
export function useSessionSubscription(sessionId: string | null | undefined): void {
  useEffect(() => {
    if (!sessionId) return
    useSessionStreamStore.getState().ensure(sessionId)
    subscribe(sessionId)
    return () => {
      unsubscribe(sessionId)
    }
  }, [sessionId])
}

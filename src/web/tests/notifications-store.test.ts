import { describe, it, expect, beforeEach } from 'vitest'
import { useNotificationsStore } from '@/stores/notifications'

describe('notifications store', () => {
  beforeEach(() => {
    useNotificationsStore.setState({ unresolvedAttentionCount: 0, toastQueue: [] })
  })

  it('increments the attention count on attention_needed notifications', () => {
    useNotificationsStore.getState().applyEvent({
      type: 'notification.created',
      notificationId: 1,
      ts: 1,
      kind: 'attention_needed',
      title: 'Q',
      body: 'ask',
    } as never)
    expect(useNotificationsStore.getState().unresolvedAttentionCount).toBe(1)
    expect(useNotificationsStore.getState().toastQueue).toHaveLength(1)
  })

  it('does not increment count for info notifications', () => {
    useNotificationsStore.getState().applyEvent({
      type: 'notification.created',
      notificationId: 1,
      ts: 1,
      kind: 'info',
      title: 'fyi',
    } as never)
    expect(useNotificationsStore.getState().unresolvedAttentionCount).toBe(0)
    expect(useNotificationsStore.getState().toastQueue).toHaveLength(1)
  })

  it('decrements on resolution', () => {
    useNotificationsStore.setState({ unresolvedAttentionCount: 3 })
    useNotificationsStore.getState().applyEvent({
      type: 'notification.resolved',
      notificationId: 1,
      ts: 1,
    } as never)
    expect(useNotificationsStore.getState().unresolvedAttentionCount).toBe(2)
  })

  it('floors at 0', () => {
    useNotificationsStore.getState().applyEvent({
      type: 'notification.resolved',
      notificationId: 1,
      ts: 1,
    } as never)
    expect(useNotificationsStore.getState().unresolvedAttentionCount).toBe(0)
  })

  it('reconcileCount overwrites the local counter', () => {
    useNotificationsStore.getState().reconcileCount(5)
    expect(useNotificationsStore.getState().unresolvedAttentionCount).toBe(5)
  })
})

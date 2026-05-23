import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useNotifications, useUpdateNotification, useAnswerNotification } from '@/api/notifications'
import { useUiStore } from '@/stores/ui'
import { formatRelative } from '@/lib/time'
import { isAttentionPayload, type Notification } from '@/types/domain'

function NotificationRow({ n }: { n: Notification }) {
  const update = useUpdateNotification()
  const answer = useAnswerNotification(n.sessionId ?? '')
  const isAttention = n.kind === 'attention_needed'
  const payload = n.payload
  const showOptions = isAttention && isAttentionPayload(payload) && payload.options && payload.options.length > 0

  return (
    <div className="p-3 border border-border rounded-md bg-bg space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-semibold text-fg">{n.title}</div>
        <div className="text-[10px] text-muted whitespace-nowrap">
          {formatRelative(n.createdAt)}
        </div>
      </div>
      {n.body ? <div className="text-xs text-muted whitespace-pre-wrap">{n.body}</div> : null}
      {showOptions && isAttentionPayload(payload) ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {payload.options!.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant="secondary"
              disabled={answer.isPending || !n.sessionId}
              onClick={() => {
                if (!n.sessionId) return
                answer.mutate({ notifId: n.id, body: { value: opt.value } })
              }}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : isAttention && n.sessionId ? (
        <Link
          to={`/chat/${n.sessionId}`}
          className="inline-block text-xs text-accent hover:underline"
        >
          Open in chat →
        </Link>
      ) : null}
      <div className="flex gap-1 text-[10px]">
        {n.status === 'unread' ? (
          <button
            onClick={() => update.mutate({ id: n.id, body: { status: 'read' } })}
            className="text-muted hover:text-fg"
          >
            Mark read
          </button>
        ) : null}
        {n.status !== 'resolved' && n.status !== 'dismissed' ? (
          <button
            onClick={() => update.mutate({ id: n.id, body: { status: 'dismissed' } })}
            className="text-muted hover:text-fg ml-auto"
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function NotificationTray() {
  const { trayOpen, setTrayOpen } = useUiStore()
  const [showResolved, setShowResolved] = useState(false)
  const notifs = useNotifications({ includeResolved: showResolved })
  return (
    <Sheet open={trayOpen} onOpenChange={setTrayOpen} title="Notifications">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] text-muted">
            {(notifs.data ?? []).length} {showResolved ? 'total' : 'active'}
          </div>
          <button
            onClick={() => setShowResolved((v) => !v)}
            className="text-[10px] text-muted hover:text-fg"
          >
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </button>
        </div>
        {(notifs.data ?? []).length === 0 ? (
          <div className="text-xs text-muted text-center py-6">No notifications.</div>
        ) : null}
        <div className="space-y-2">
          {(notifs.data ?? []).map((n) => (
            <NotificationRow key={n.id} n={n} />
          ))}
        </div>
      </div>
    </Sheet>
  )
}

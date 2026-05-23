import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { useEffect } from 'react'
import { useSessionSubscription } from '@/lib/ws'
import { useSessionStreamStore } from '@/stores/session-stream'
import { MessageList } from '@/routes/chat/MessageList'

export interface InlineSessionStreamProps {
  sessionId: string
  open: boolean
  onOpenChange(open: boolean): void
  onAwaitingInput?(question: string, notificationId: number): void
}

export function InlineSessionStream({
  sessionId,
  open,
  onOpenChange,
  onAwaitingInput,
}: InlineSessionStreamProps) {
  useSessionSubscription(sessionId)
  const awaitingInput = useSessionStreamStore(
    (s) => s.byId[sessionId]?.awaitingInput,
  )

  useEffect(() => {
    if (awaitingInput && onAwaitingInput) {
      onAwaitingInput(awaitingInput.question, awaitingInput.notificationId)
    }
  }, [awaitingInput, onAwaitingInput])

  return (
    <div className="border border-border rounded-md bg-surface">
      <div className="flex items-center justify-between px-3 h-8 border-b border-border">
        <button onClick={() => onOpenChange(!open)} className="flex items-center gap-1 text-xs text-fg">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Agent stream
        </button>
        <Link
          to={`/chat/${sessionId}`}
          className="text-[10px] text-accent hover:underline flex items-center gap-1"
        >
          Open in full chat <ExternalLink size={10} />
        </Link>
      </div>
      {open ? (
        <div className="h-80">
          <MessageList sessionId={sessionId} embedded />
        </div>
      ) : null}
      {awaitingInput && !open ? (
        <div className="bg-warn/10 border-t border-warn/30 px-3 py-1 text-[11px] text-warn">
          Agent is waiting for input — check the notification tray.
        </div>
      ) : null}
    </div>
  )
}

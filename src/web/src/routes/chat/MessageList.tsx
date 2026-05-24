import { useEffect, useRef, useState } from 'react'
import { useSessionStreamStore } from '@/stores/session-stream'
import { useComposerDraftStore } from '@/stores/composer-draft'
import { useSession } from '@/api/sessions'
import { MessageItem } from './MessageItem'
import { StarterCard } from './StarterCard'
import { ToolChip } from './ToolChip'
import { cn } from '@/lib/cn'
import type { Turn } from '@/types/domain'

export interface MessageListProps {
  sessionId: string
  /** When true, scrolls within the container rather than the viewport. */
  embedded?: boolean
}

export function MessageList({ sessionId, embedded = false }: MessageListProps) {
  // Triggering the detail fetch ensures hydrateFromDetail() runs on mount.
  useSession(sessionId)
  const stream = useSessionStreamStore((s) => s.byId[sessionId])
  const containerRef = useRef<HTMLDivElement>(null)
  const [pinnedToBottom, setPinnedToBottom] = useState(true)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (pinnedToBottom) el.scrollTop = el.scrollHeight
  }, [stream?.turns.length, stream?.activeAssistant?.text, pinnedToBottom])

  function onScroll() {
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setPinnedToBottom(nearBottom)
  }

  if (!stream) {
    return <div className="p-6 text-sm text-muted">Loading…</div>
  }

  const isFresh =
    stream.turns.length === 0 &&
    !stream.activeAssistant &&
    stream.metaRows.length === 0

  const activeTurn: Turn | null = stream.activeAssistant
    ? {
        id: stream.activeAssistant.turnId,
        sessionId,
        role: 'assistant',
        content: stream.activeAssistant.text,
        tokenCount: 0,
        createdAt: Date.now(),
      }
    : null
  const activeChips = stream.activeAssistant
    ? Object.values(stream.activeAssistant.toolChips)
    : []

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className={cn(
        'overflow-auto scrollbar-thin',
        embedded ? 'h-full px-3 py-2' : 'flex-1 px-3 md:px-6 py-3 md:py-4',
      )}
    >
      <div
        className={cn(
          'flex flex-col justify-end min-h-full',
          embedded ? 'space-y-3' : 'mx-auto max-w-[760px] space-y-5',
        )}
      >
        {isFresh && !embedded ? (
          <StarterCard
            onPick={(text) => {
              useComposerDraftStore.getState().set(sessionId, text)
            }}
          />
        ) : null}
        {stream.turns.map((turn) => (
          <MessageItem
            key={turn.id}
            turn={turn}
            toolChips={stream.toolCalls[turn.id] ?? []}
            recallSources={stream.recallByTurn[turn.id] ?? []}
          />
        ))}
        {activeTurn ? (
          <MessageItem turn={activeTurn} toolChips={activeChips} isActive />
        ) : null}
        {stream.metaRows.length > 0 ? (
          <div className="space-y-1 pt-2 border-t border-border">
            {stream.metaRows.map((row) => (
              <div
                key={row.id}
                className={cn(
                  'text-[11px]',
                  row.kind === 'error' && 'text-danger',
                  row.kind === 'warn' && 'text-warn',
                  row.kind === 'info' && 'text-muted',
                )}
              >
                {row.text}
              </div>
            ))}
          </div>
        ) : null}
        {stream.activeAssistant && activeChips.length === 0 && stream.activeAssistant.text === '' ? (
          <div className="text-xs text-muted">Thinking…</div>
        ) : null}
        {/* Pending tool chips with no text are tracked above; show them inline anyway. */}
      </div>
      {!pinnedToBottom ? (
        <button
          onClick={() => {
            const el = containerRef.current
            if (el) {
              el.scrollTop = el.scrollHeight
              setPinnedToBottom(true)
            }
          }}
          className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-accent text-white text-xs rounded-full px-3 py-1 shadow-md"
        >
          Jump to latest
        </button>
      ) : null}
    </div>
  )
}

export { ToolChip }

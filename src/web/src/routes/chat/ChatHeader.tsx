import { useEffect, useRef, useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { useRenameSession, useSession } from '@/api/sessions'
import { useHealth } from '@/api/health'
import { formatRelative } from '@/lib/time'
import { cn } from '@/lib/cn'

export interface ChatHeaderProps {
  sessionId: string
}

export function ChatHeader({ sessionId }: ChatHeaderProps) {
  const session = useSession(sessionId)
  const health = useHealth()
  const rename = useRenameSession(sessionId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const data = session.data
  const displayTitle = data?.session.title ?? data?.session.id.slice(0, 8) ?? '—'
  const profile = data?.session.agentProfile ?? ''
  const bootProfile = health.data?.agentProfile ?? ''
  const mismatch = profile && bootProfile && profile !== bootProfile

  useEffect(() => {
    if (editing) {
      setDraft(data?.session.title ?? '')
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [editing, data?.session.title])

  function commit() {
    const value = draft.trim()
    if (!value || value === data?.session.title) {
      setEditing(false)
      return
    }
    rename.mutate(
      { title: value },
      {
        onSuccess: () => setEditing(false),
      },
    )
  }

  return (
    <div className="h-9 shrink-0 border-b border-border px-6 flex items-center gap-3 bg-bg group">
      <div className="flex-1 min-w-0 flex items-center gap-2">
        {editing ? (
          <>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                else if (e.key === 'Escape') setEditing(false)
              }}
              className="text-sm font-medium bg-surface border border-border rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-accent min-w-0 flex-1"
              maxLength={120}
            />
            <button
              type="button"
              onClick={commit}
              className="p-1 rounded hover:bg-surface text-muted hover:text-fg"
              aria-label="Save title"
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="p-1 rounded hover:bg-surface text-muted hover:text-fg"
              aria-label="Cancel rename"
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <>
            <span className="text-sm font-medium text-fg truncate" title={displayTitle}>
              {displayTitle}
            </span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="p-1 rounded hover:bg-surface text-muted hover:text-fg opacity-0 group-hover:opacity-100 focus:opacity-100"
              aria-label="Rename session"
              title="Rename"
            >
              <Pencil size={11} />
            </button>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted shrink-0">
        {profile ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 border',
              mismatch
                ? 'border-warn/40 text-warn bg-warn/5'
                : 'border-border text-muted bg-surface',
            )}
            title={mismatch ? `Session created under "${profile}"; current profile is "${bootProfile}"` : `Agent profile: ${profile}`}
          >
            {profile}
          </span>
        ) : null}
        {health.data?.model ? (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 border border-border bg-surface">
            {health.data.model}
          </span>
        ) : null}
        {data?.session.createdAt ? (
          <span className="text-muted" title={new Date(data.session.createdAt).toLocaleString()}>
            {formatRelative(data.session.createdAt)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

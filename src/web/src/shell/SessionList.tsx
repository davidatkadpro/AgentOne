import { useMemo, useState } from 'react'
import { NavLink, useParams } from 'react-router-dom'
import { Archive, CheckSquare, Plus, Search, Square, X } from 'lucide-react'
import { toast } from 'sonner'
import { useArchiveSessions, useSessions } from '@/api/sessions'
import { useHealth } from '@/api/health'
import { useUiStore } from '@/stores/ui'
import { recencyBucket, type RecencyBucket } from '@/lib/time'
import { hashColor } from '@/lib/hash-color'
import { cn } from '@/lib/cn'
import type { Session } from '@/types/domain'

const BUCKET_LABEL: Record<RecencyBucket, string> = {
  today: 'Today',
  week: 'This week',
  earlier: 'Earlier',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Pick a display label for a session. Untitled sessions show the first four
 *  hex chars of the UUID — enough to disambiguate, short enough to read at a
 *  glance. Pair with the avatar dot for a stable visual anchor. */
function sessionLabel(session: Session): string {
  if (session.title && session.title.trim()) return session.title
  if (UUID_RE.test(session.id)) return session.id.slice(0, 4)
  return session.id.slice(0, 8)
}

interface SessionRowProps {
  session: Session
  bootProfile: string
  selectionMode: boolean
  isSelected: boolean
  onToggleSelected(id: string): void
}

function SessionRow({
  session,
  bootProfile,
  selectionMode,
  isSelected,
  onToggleSelected,
}: SessionRowProps) {
  const { sessionId } = useParams<{ sessionId: string }>()
  const isActive = sessionId === session.id
  const mismatch = session.agentProfile !== bootProfile
  const dotColor = hashColor(session.id)
  const label = sessionLabel(session)

  const inner = (
    <>
      {selectionMode ? (
        isSelected ? (
          <CheckSquare size={12} className="text-accent shrink-0" />
        ) : (
          <Square size={12} className="text-muted shrink-0" />
        )
      ) : (
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: dotColor }}
          aria-hidden
        />
      )}
      <span className="truncate flex-1">{label}</span>
      {session.spawnedBy ? (
        <span className="text-[9px] uppercase bg-bg border border-border rounded px-1 py-px text-muted">
          spawned
        </span>
      ) : null}
      {mismatch ? (
        <span
          className="w-1.5 h-1.5 rounded-full bg-warn"
          title={`Profile mismatch — session was created under "${session.agentProfile}"`}
        />
      ) : null}
    </>
  )

  if (selectionMode) {
    return (
      <button
        type="button"
        onClick={() => onToggleSelected(session.id)}
        className={cn(
          'w-full text-left flex items-center gap-2 px-3 h-8 text-xs rounded-md',
          isSelected ? 'bg-accent/10 text-fg' : 'text-muted hover:text-fg hover:bg-surface',
        )}
        title={session.id}
      >
        {inner}
      </button>
    )
  }

  return (
    <NavLink
      to={`/chat/${session.id}`}
      className={cn(
        'flex items-center gap-2 px-3 h-8 text-xs rounded-md group',
        isActive ? 'bg-surface text-fg' : 'text-muted hover:text-fg hover:bg-surface',
      )}
      title={session.id}
    >
      {inner}
    </NavLink>
  )
}

export function SessionList() {
  const sessions = useSessions()
  const health = useHealth()
  const archive = useArchiveSessions()
  const { setNewChatDialogOpen } = useUiStore()
  const [filter, setFilter] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const bootProfile = health.data?.agentProfile ?? ''

  const grouped = useMemo(() => {
    const list = (sessions.data ?? [])
      .filter((s) => showArchived || s.state !== 'archived')
      .filter((s) => {
        if (!filter) return true
        const term = filter.toLowerCase()
        return (
          (s.title ?? '').toLowerCase().includes(term) || s.id.toLowerCase().includes(term)
        )
      })
    const awaitingInput = list.filter((s) => s.state === 'awaiting_input')
    const archived = list.filter((s) => s.state === 'archived')
    const buckets: Record<RecencyBucket, Session[]> = { today: [], week: [], earlier: [] }
    for (const s of list) {
      if (s.state === 'awaiting_input' || s.state === 'archived') continue
      buckets[recencyBucket(s.createdAt)].push(s)
    }
    for (const k of Object.keys(buckets) as RecencyBucket[]) {
      buckets[k].sort((a, b) => b.createdAt - a.createdAt)
    }
    return { awaitingInput, buckets, archived }
  }, [sessions.data, filter, showArchived])

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitSelectionMode() {
    setSelectionMode(false)
    setSelected(new Set())
  }

  function commitArchive() {
    const ids = Array.from(selected)
    if (ids.length === 0) {
      exitSelectionMode()
      return
    }
    archive.mutate(ids, {
      onSuccess: () => {
        toast.success(`Archived ${ids.length} session${ids.length === 1 ? '' : 's'}`)
        exitSelectionMode()
      },
      onError: (err) => {
        toast.error('Archive failed', {
          description: err instanceof Error ? err.message : String(err),
        })
      },
    })
  }

  const allEmpty =
    grouped.awaitingInput.length === 0 &&
    grouped.buckets.today.length === 0 &&
    grouped.buckets.week.length === 0 &&
    grouped.buckets.earlier.length === 0 &&
    grouped.archived.length === 0

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-2 pb-2 pt-2 shrink-0">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search sessions"
            className="w-full h-7 pl-7 pr-2 text-xs rounded-md bg-bg border border-border text-fg placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        {selectionMode ? (
          <button
            onClick={exitSelectionMode}
            aria-label="Exit selection"
            title="Exit selection"
            className="p-1 rounded hover:bg-surface text-muted hover:text-fg"
          >
            <X size={14} />
          </button>
        ) : (
          <>
            <button
              onClick={() => setSelectionMode(true)}
              aria-label="Select sessions"
              title="Select sessions to archive"
              className="p-1 rounded hover:bg-surface text-muted hover:text-fg"
            >
              <CheckSquare size={14} />
            </button>
            <button
              onClick={() => setNewChatDialogOpen(true)}
              aria-label="New chat"
              className="p-1 rounded hover:bg-surface text-muted hover:text-fg"
            >
              <Plus size={14} />
            </button>
          </>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 space-y-2 pb-2">
        {filter && allEmpty ? (
          <div className="px-3 py-4 text-[11px] text-muted">
            No sessions match <span className="text-fg font-medium">"{filter}"</span>.
          </div>
        ) : null}
        {grouped.awaitingInput.length > 0 ? (
          <div>
            <div className="px-3 text-[10px] uppercase text-warn font-semibold">Awaiting input</div>
            <div className="space-y-0.5 mt-1">
              {grouped.awaitingInput.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  bootProfile={bootProfile}
                  selectionMode={selectionMode}
                  isSelected={selected.has(s.id)}
                  onToggleSelected={toggleSelected}
                />
              ))}
            </div>
          </div>
        ) : null}
        {(Object.keys(grouped.buckets) as RecencyBucket[]).map((bucket) =>
          grouped.buckets[bucket].length > 0 ? (
            <div key={bucket}>
              <div className="px-3 text-[10px] uppercase text-muted">{BUCKET_LABEL[bucket]}</div>
              <div className="space-y-0.5 mt-1">
                {grouped.buckets[bucket].map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    bootProfile={bootProfile}
                    selectionMode={selectionMode}
                    isSelected={selected.has(s.id)}
                    onToggleSelected={toggleSelected}
                  />
                ))}
              </div>
            </div>
          ) : null,
        )}
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="px-3 text-[10px] text-muted hover:text-fg"
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
        {showArchived && grouped.archived.length > 0 ? (
          <div>
            <div className="px-3 text-[10px] uppercase text-muted">Archived</div>
            <div className="space-y-0.5 mt-1">
              {grouped.archived.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  bootProfile={bootProfile}
                  selectionMode={selectionMode}
                  isSelected={selected.has(s.id)}
                  onToggleSelected={toggleSelected}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {selectionMode ? (
        <div className="shrink-0 border-t border-border px-2 py-2 flex items-center gap-2 bg-bg">
          <span className="text-[11px] text-muted flex-1">
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={commitArchive}
            disabled={selected.size === 0 || archive.isPending}
            className={cn(
              'inline-flex items-center gap-1 text-[11px] rounded-md px-2 py-1 border',
              selected.size === 0 || archive.isPending
                ? 'border-border text-muted/60 cursor-not-allowed'
                : 'border-accent/40 text-accent hover:bg-accent/5',
            )}
          >
            <Archive size={11} /> Archive
          </button>
        </div>
      ) : null}
    </div>
  )
}

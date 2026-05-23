import { useMemo, useState } from 'react'
import { NavLink, useParams } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { useSessions } from '@/api/sessions'
import { useHealth } from '@/api/health'
import { useUiStore } from '@/stores/ui'
import { recencyBucket, type RecencyBucket } from '@/lib/time'
import { cn } from '@/lib/cn'
import type { Session } from '@/types/domain'

const BUCKET_LABEL: Record<RecencyBucket, string> = {
  today: 'Today',
  week: 'This week',
  earlier: 'Earlier',
}

function SessionRow({ session, bootProfile }: { session: Session; bootProfile: string }) {
  const { sessionId } = useParams<{ sessionId: string }>()
  const isActive = sessionId === session.id
  const mismatch = session.agentProfile !== bootProfile
  return (
    <NavLink
      to={`/chat/${session.id}`}
      className={cn(
        'flex items-center gap-2 px-3 h-8 text-xs rounded-md group',
        isActive ? 'bg-surface text-fg' : 'text-muted hover:text-fg hover:bg-surface',
      )}
      title={session.id}
    >
      <span className="truncate flex-1">{session.title ?? session.id.slice(0, 8)}</span>
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
    </NavLink>
  )
}

export function SessionList() {
  const sessions = useSessions()
  const health = useHealth()
  const { setNewChatDialogOpen } = useUiStore()
  const [filter, setFilter] = useState('')
  const [showArchived, setShowArchived] = useState(false)
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 pb-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search sessions"
            className="w-full h-7 pl-7 pr-2 text-xs rounded-md bg-bg border border-border text-fg placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <button
          onClick={() => setNewChatDialogOpen(true)}
          aria-label="New chat"
          className="p-1 rounded hover:bg-surface text-muted hover:text-fg"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin px-2 space-y-2 pb-2">
        {grouped.awaitingInput.length > 0 ? (
          <div>
            <div className="px-3 text-[10px] uppercase text-warn font-semibold">Awaiting input</div>
            <div className="space-y-0.5 mt-1">
              {grouped.awaitingInput.map((s) => (
                <SessionRow key={s.id} session={s} bootProfile={bootProfile} />
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
                  <SessionRow key={s.id} session={s} bootProfile={bootProfile} />
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
                <SessionRow key={s.id} session={s} bootProfile={bootProfile} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

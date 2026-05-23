import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/shared/EmptyState'
import { useProjectActivity } from '@/api/projects'
import { formatRelative } from '@/lib/time'
import type { ActivityEntry } from '@/types/domain'

export interface ActivityTabProps {
  projectId: string
}

export function ActivityTab({ projectId }: ActivityTabProps) {
  const [offset, setOffset] = useState(0)
  const activity = useProjectActivity(projectId, { limit: 50, offset })
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  if (activity.isLoading) {
    return <div className="p-4 text-xs text-muted">Loading activity…</div>
  }
  const entries = activity.data?.entries ?? []

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        body="Creating phases, tasks, and status changes will appear here."
      />
    )
  }

  return (
    <div className="flex flex-col h-full">
      <ul className="flex-1 overflow-auto scrollbar-thin">
        {entries.map((e) => (
          <ActivityRow
            key={e.id}
            entry={e}
            expanded={expanded.has(e.id)}
            onToggle={() => {
              setExpanded((s) => {
                const next = new Set(s)
                if (next.has(e.id)) next.delete(e.id)
                else next.add(e.id)
                return next
              })
            }}
          />
        ))}
      </ul>
      {activity.data?.hasMore ? (
        <div className="border-t border-border p-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setOffset(offset + 50)}
          >
            Load older
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ActivityRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ActivityEntry
  expanded: boolean
  onToggle(): void
}) {
  return (
    <li className="px-3 py-2 border-b border-border text-xs">
      <div className="flex items-center gap-2">
        <span className="font-mono text-muted w-16 tabular-nums">
          {formatRelative(entry.ts)}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted">
          {entry.actorKind}
        </span>
        <span className="flex-1">
          <span className="text-muted">{entry.module}.</span>
          <span className="font-medium">{entry.action}</span>
          {entry.targetId ? (
            <span className="ml-1 font-mono text-[10px] text-muted">
              {entry.targetId.slice(0, 8)}
            </span>
          ) : null}
        </span>
        <button onClick={onToggle} className="text-[10px] text-accent hover:underline">
          {expanded ? 'Hide' : 'Details'}
        </button>
      </div>
      {expanded ? (
        <pre className="mt-1 ml-16 p-2 bg-bg rounded text-[10px] whitespace-pre-wrap break-all">
          {JSON.stringify(entry.details, null, 2)}
        </pre>
      ) : null}
    </li>
  )
}

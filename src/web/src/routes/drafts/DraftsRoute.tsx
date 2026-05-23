import { useDrafts } from '@/api/drafts'
import { RouteSkeleton } from '@/components/shared/RouteSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { StickyNote } from 'lucide-react'

export function DraftsRoute() {
  const drafts = useDrafts()
  if (drafts.isPending) return <RouteSkeleton variant="list" />
  if (!drafts.data || drafts.data.length === 0) {
    return (
      <EmptyState
        icon={<StickyNote size={36} />}
        title="No drafts yet"
        body="Drafts produced by /distill and auto-distill will show up here."
      />
    )
  }
  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-lg font-semibold mb-4">Drafts</h1>
      <div className="space-y-2">
        {drafts.data.map((d) => (
          <div
            key={d.path}
            className="p-3 bg-surface border border-border rounded-md flex items-center justify-between"
          >
            <div>
              <div className="text-sm font-medium text-fg">{d.title}</div>
              <div className="text-[11px] text-muted font-mono">{d.path}</div>
            </div>
            <div className="text-[11px] text-muted text-right">
              <div>
                {d.noteCount} note{d.noteCount === 1 ? '' : 's'}
              </div>
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(d.path)
                }}
                className="text-accent hover:underline mt-1"
              >
                Copy path
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

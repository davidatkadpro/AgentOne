import { useProposalHistory } from '@/api/proposals'
import { formatRelative } from '@/lib/time'

export interface HistoryPopoverProps {
  artifactId: string
  open: boolean
  onOpenChange(open: boolean): void
}

export function HistoryPopover({ artifactId, open, onOpenChange }: HistoryPopoverProps) {
  const history = useProposalHistory(open ? artifactId : null)
  if (!open) return null
  return (
    <div
      className="border-b border-border bg-surface"
      data-testid="proposal-history-panel"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold">History</span>
        <button
          className="text-[10px] text-muted hover:text-fg"
          onClick={() => onOpenChange(false)}
          data-testid="proposal-history-close"
        >
          Close
        </button>
      </div>
      {history.isLoading ? (
        <div className="px-3 py-2 text-[11px] text-muted">Loading history…</div>
      ) : history.isError ? (
        <div className="px-3 py-2 text-[11px] text-danger">
          History unavailable.
        </div>
      ) : history.data && history.data.entries.length > 0 ? (
        <ul className="max-h-56 overflow-auto scrollbar-thin">
          {history.data.entries.map((e, i) => (
            <li
              key={`${e.ts}-${i}`}
              className="px-3 py-1.5 border-b border-border text-[11px] flex items-center gap-2"
              data-testid="proposal-history-entry"
            >
              <span className="text-muted w-20 shrink-0">
                {formatRelative(e.ts)}
              </span>
              <span className="font-mono text-muted w-16 shrink-0 truncate">
                {e.actorKind}
              </span>
              <span className="flex-1 truncate">{e.action}</span>
              {e.toStatus ? (
                <span className="font-mono text-muted">→ {e.toStatus}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-3 py-2 text-[11px] text-muted italic">No history yet.</div>
      )}
    </div>
  )
}

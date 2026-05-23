import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/time'
import { ArtifactStatusBadge } from './ArtifactStatusBadge'
import type { ArtifactRow } from '@/types/domain'

export interface ArtifactListRowProps {
  row: ArtifactRow
  isActive: boolean
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function ArtifactListRow({ row, isActive }: ArtifactListRowProps) {
  const navigate = useNavigate()
  return (
    <div
      data-testid="artifact-row"
      data-active={isActive ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/proposals/${row.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          navigate(`/proposals/${row.id}`)
        }
      }}
      className={cn(
        'px-3 py-2 border-b border-border cursor-pointer flex flex-col gap-1',
        isActive ? 'bg-accent/5' : 'hover:bg-bg/60',
      )}
    >
      <div className="flex items-center gap-2">
        <div className="font-mono text-xs font-medium truncate flex-1">{row.number}</div>
        <ArtifactStatusBadge displayStatus={row.displayStatus} />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted">
        <button
          onClick={(e) => {
            e.stopPropagation()
            navigate(`/projects/${row.projectId}`)
          }}
          className="hover:underline hover:text-fg truncate"
          data-testid="artifact-row-project-link"
        >
          {row.projectNumber} {row.projectName}
        </button>
        <div className="font-mono">{formatMoney(row.totalCents)}</div>
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted">
        <span>{row.source}</span>
        <span title={new Date(row.lastActivity).toLocaleString()}>
          {formatRelative(row.lastActivity)}
        </span>
      </div>
    </div>
  )
}

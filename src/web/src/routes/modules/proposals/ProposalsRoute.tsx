import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { ModulePanel } from '@/components/module/ModulePanel'
import { KpiStrip, type KpiPill } from '@/components/module/KpiStrip'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useArtifacts } from '@/api/proposals'
import type { ArtifactRow } from '@/types/domain'
import { ArtifactListRow } from './components/ArtifactListRow'
import { NewProposalDialog } from './components/NewProposalDialog'
import { ProposalDetailRoute } from './ProposalDetailRoute'
import {
  FILTER_TO_DISPLAY_STATUS,
  isArtifactFilter,
  type ArtifactFilterId,
} from './hooks/useProposalDeepLink'

function startOfThisMonth(): number {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function ProposalsRoute() {
  const navigate = useNavigate()
  const params = useParams<{ proposalId?: string }>()
  const [search, setSearch] = useSearchParams()
  const filterRaw = search.get('filter')
  const filter: ArtifactFilterId = isArtifactFilter(filterRaw) ? filterRaw : 'all'
  const projectFilter = search.get('project')
  const [query, setQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)

  // Pull the unfiltered set so KPI counts reflect the full picture.
  const base = useArtifacts(projectFilter ? { projectId: projectFilter } : undefined)
  const rows = base.data ?? []

  const visible = useMemo<ArtifactRow[]>(() => {
    const allowed = FILTER_TO_DISPLAY_STATUS[filter]
    let out = rows
    if (allowed) out = out.filter((r) => allowed.includes(r.displayStatus))
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      out = out.filter(
        (r) =>
          r.number.toLowerCase().includes(q) ||
          r.projectNumber.toLowerCase().includes(q) ||
          r.projectName.toLowerCase().includes(q),
      )
    }
    return out
  }, [rows, filter, query])

  const kpis: KpiPill[] = useMemo(() => {
    const drafts = rows.filter(
      (r) => r.displayStatus === 'Estimate · draft' || r.displayStatus === 'Proposal · draft',
    ).length
    const awaiting = rows.filter((r) => r.displayStatus === 'Proposal · issued').length
    const monthStart = startOfThisMonth()
    const accepted = rows.filter(
      (r) => r.displayStatus === 'Proposal · accepted' && r.lastActivity >= monthStart,
    ).length
    return [
      { id: 'drafts', label: 'Drafts', count: drafts },
      {
        id: 'issued',
        label: 'Issued awaiting',
        count: awaiting,
        tone: awaiting > 0 ? 'warn' : 'default',
      },
      { id: 'accepted', label: 'Accepted this month', count: accepted },
    ]
  }, [rows])

  function onPillClick(id: string) {
    const next = new URLSearchParams(search)
    if (filter === id) next.delete('filter')
    else next.set('filter', id)
    setSearch(next, { replace: true })
  }

  const selectedId = params.proposalId ?? null

  return (
    <>
      <ModulePanel
        kpiStrip={
          <div className="flex items-center justify-between gap-2 pr-3 min-w-0">
            <div className="flex-1 min-w-0">
              <KpiStrip
                pills={kpis}
                activePillId={filter === 'all' ? null : filter}
                onPillClick={onPillClick}
              />
            </div>
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              data-testid="new-proposal-button"
              className="shrink-0"
            >
              <Plus size={12} /> <span className="hidden sm:inline">New proposal</span>
            </Button>
          </div>
        }
        list={
          <div className="flex flex-col h-full">
            <div className="p-2 border-b border-border">
              <div className="relative">
                <Search
                  size={12}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-muted"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search proposals…"
                  className="h-8 pl-7 text-xs"
                  data-testid="proposals-search"
                />
              </div>
              {projectFilter ? (
                <button
                  onClick={() => {
                    const next = new URLSearchParams(search)
                    next.delete('project')
                    setSearch(next, { replace: true })
                  }}
                  className="mt-1 text-[10px] text-muted hover:text-fg underline"
                  data-testid="clear-project-filter"
                >
                  Clear project filter
                </button>
              ) : null}
            </div>
            {base.isLoading ? (
              <div className="p-4 text-xs text-muted">Loading proposals…</div>
            ) : visible.length === 0 ? (
              <EmptyState
                title={
                  rows.length === 0
                    ? 'No proposals yet'
                    : 'No proposals match the filter'
                }
                body={
                  rows.length === 0
                    ? 'Create one from + New proposal.'
                    : 'Try clearing filters or the search box.'
                }
              />
            ) : (
              <div className="flex-1 overflow-auto scrollbar-thin">
                {visible.map((row) => (
                  <ArtifactListRow
                    key={`${row.kind}-${row.id}`}
                    row={row}
                    isActive={row.id === selectedId}
                  />
                ))}
              </div>
            )}
          </div>
        }
        detail={selectedId ? <ProposalDetailRoute artifactId={selectedId} /> : null}
        emptyState={
          <EmptyState
            title="Select a proposal"
            body="Pick an estimate or proposal from the list to edit it and preview the rendered output."
          />
        }
      />
      <NewProposalDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultProjectId={projectFilter ?? undefined}
        onCreated={(id) => navigate(`/proposals/${id}`)}
      />
    </>
  )
}

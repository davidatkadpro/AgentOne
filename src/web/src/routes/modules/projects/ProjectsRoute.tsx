import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { ModulePanel } from '@/components/module/ModulePanel'
import { KpiStrip, type KpiPill } from '@/components/module/KpiStrip'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useProjects } from '@/api/projects'
import type { EntityStatus, Project } from '@/types/domain'
import { ProjectListRow } from './components/ProjectListRow'
import { NewProjectDialog } from './components/NewProjectDialog'
import { ProjectDetailRoute } from './ProjectDetailRoute'

type FilterId = 'all' | 'active' | 'blocked' | 'awaitingInvoice' | 'overdue'

const FILTER_TO_STATUSES: Record<FilterId, EntityStatus[] | undefined> = {
  all: undefined,
  active: ['active'],
  blocked: ['blocked'],
  awaitingInvoice: ['active'], // Phase 5 narrows further
  overdue: ['active'], // Phase 5 narrows further
}

function filterFromSearch(params: URLSearchParams): FilterId {
  const f = params.get('filter')
  if (f === 'active' || f === 'blocked' || f === 'awaitingInvoice' || f === 'overdue') return f
  return 'all'
}

export function ProjectsRoute() {
  const navigate = useNavigate()
  const params = useParams<{ projectId?: string }>()
  const [search, setSearch] = useSearchParams()
  const filter = filterFromSearch(search)
  const showCompleted = search.get('completed') === 'true'

  const [query, setQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)

  // Always fetch the default visible band so the KPI pill counts reflect
  // the whole project space (not just the active filter slice).
  const baseQuery = useProjects(undefined)
  const projects = baseQuery.data ?? []

  const visible = useMemo<Project[]>(() => {
    let rows = projects
    if (!showCompleted) {
      rows = rows.filter((p) => p.status !== 'completed' && p.status !== 'cancelled')
    }
    const allowed = FILTER_TO_STATUSES[filter]
    if (allowed) {
      rows = rows.filter((p) => allowed.includes(p.status))
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      rows = rows.filter(
        (p) =>
          p.number.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (p.client ?? '').toLowerCase().includes(q),
      )
    }
    return [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [projects, showCompleted, filter, query])

  const kpis: KpiPill[] = useMemo(() => {
    const counts = {
      active: projects.filter((p) => p.status === 'active').length,
      blocked: projects.filter((p) => p.status === 'blocked').length,
    }
    return [
      { id: 'active', label: 'Active', count: counts.active },
      { id: 'blocked', label: 'Blocked', count: counts.blocked, tone: counts.blocked > 0 ? 'warn' : 'default' },
      // Phase 5 will populate these properly — until then the pill renders 0.
      { id: 'awaitingInvoice', label: 'Awaiting invoice', count: 0 },
      { id: 'overdue', label: 'Overdue', count: 0, tone: 'error' },
    ]
  }, [projects])

  function onPillClick(id: string) {
    const next = new URLSearchParams(search)
    if (filter === id) next.delete('filter')
    else next.set('filter', id)
    setSearch(next, { replace: true })
  }

  const selectedId = params.projectId ?? null

  return (
    <>
      <ModulePanel
        kpiStrip={
          <div className="flex items-center justify-between pr-3">
            <KpiStrip
              pills={kpis}
              activePillId={filter === 'all' ? null : filter}
              onPillClick={onPillClick}
            />
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              data-testid="new-project-button"
            >
              <Plus size={12} /> New project
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
                  placeholder="Search projects…"
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <label className="flex items-center gap-1 mt-2 text-[10px] text-muted">
                <input
                  type="checkbox"
                  checked={showCompleted}
                  onChange={(e) => {
                    const next = new URLSearchParams(search)
                    if (e.target.checked) next.set('completed', 'true')
                    else next.delete('completed')
                    setSearch(next, { replace: true })
                  }}
                />
                Show completed / cancelled
              </label>
            </div>
            {baseQuery.isLoading ? (
              <div className="p-4 text-xs text-muted">Loading projects…</div>
            ) : visible.length === 0 ? (
              <EmptyState
                title="No projects yet"
                body={
                  projects.length === 0
                    ? 'Create your first project from the New project button.'
                    : 'No projects match your filter.'
                }
              />
            ) : (
              <div className="flex-1 overflow-auto scrollbar-thin">
                {visible.map((p) => (
                  <ProjectListRow
                    key={p.id}
                    project={p}
                    budget={null}
                    lastActivity={p.updatedAt}
                    isActive={p.id === selectedId}
                    onClick={() => navigate(`/projects/${p.id}`)}
                  />
                ))}
              </div>
            )}
          </div>
        }
        detail={selectedId ? <ProjectDetailRoute projectId={selectedId} /> : null}
        emptyState={
          <EmptyState
            title="Select a project"
            body="Pick a project from the list to see its tasks, scope, files, and activity."
          />
        }
      />
      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(id) => navigate(`/projects/${id}`)}
      />
    </>
  )
}

import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import { ModulePanel } from '@/components/module/ModulePanel'
import { KpiStrip, type KpiPill } from '@/components/module/KpiStrip'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/shared/EmptyState'
import { useEmails } from '@/api/email'
import { useEmailChip } from '@/stores/email-chips'
import { EmailListRow } from './components/EmailListRow'
import { EmailRefreshButton } from './components/EmailRefreshButton'
import { EmailDetailRoute } from './EmailDetailRoute'

type FilterId = 'all' | 'unread' | 'filed' | 'attached'

function filterFromSearch(params: URLSearchParams): FilterId {
  const f = params.get('filter')
  if (f === 'unread' || f === 'filed' || f === 'attached') return f
  return 'all'
}

export function EmailRoute() {
  const navigate = useNavigate()
  const params = useParams<{ emailId?: string }>()
  const [search, setSearch] = useSearchParams()
  const filter = filterFromSearch(search)
  const [query, setQuery] = useState('')

  // We always pull the unfiltered set so the KPI counts reflect everything.
  // Filtering the visible rows is client-side because the server only
  // accepts one filter at a time.
  const base = useEmails({})
  const emails = base.data ?? []

  const visible = useMemo(() => {
    let rows = emails
    if (filter === 'unread') rows = rows.filter((e) => !e.isRead)
    else if (filter === 'filed') rows = rows.filter((e) => e.filedProjectId !== null)
    else if (filter === 'attached') rows = rows.filter((e) => e.hasAttachments)
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      rows = rows.filter(
        (e) =>
          (e.subject ?? '').toLowerCase().includes(q) ||
          e.fromAddress.toLowerCase().includes(q) ||
          (e.fromName ?? '').toLowerCase().includes(q) ||
          (e.snippet ?? '').toLowerCase().includes(q),
      )
    }
    return rows
  }, [emails, filter, query])

  const kpis: KpiPill[] = useMemo(() => {
    const unread = emails.filter((e) => !e.isRead).length
    const filed = emails.filter((e) => e.filedProjectId !== null).length
    const attached = emails.filter((e) => e.hasAttachments).length
    return [
      { id: 'unread', label: 'Unread', count: unread, tone: unread > 0 ? 'warn' : 'default' },
      { id: 'filed', label: 'Filed', count: filed },
      { id: 'attached', label: 'Has attachments', count: attached },
    ]
  }, [emails])

  function onPillClick(id: string) {
    const next = new URLSearchParams(search)
    if (filter === id) next.delete('filter')
    else next.set('filter', id)
    setSearch(next, { replace: true })
  }

  const selectedId = params.emailId ?? null

  return (
    <ModulePanel
      kpiStrip={
        <div className="flex items-center justify-between pr-3">
          <KpiStrip
            pills={kpis}
            activePillId={filter === 'all' ? null : filter}
            onPillClick={onPillClick}
          />
          <EmailRefreshButton />
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
                placeholder="Search subject / sender…"
                className="h-8 pl-7 text-xs"
                data-testid="email-search"
              />
            </div>
          </div>
          {base.isLoading ? (
            <div className="p-4 text-xs text-muted">Loading inbox…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              title={emails.length === 0 ? 'No emails yet' : 'No emails match the filter'}
              body={
                emails.length === 0
                  ? 'Drop .eml files into the maildir or hit Refresh to poll.'
                  : 'Try clearing filters or the search box.'
              }
            />
          ) : (
            <div className="flex-1 overflow-auto scrollbar-thin">
              {visible.map((email) => (
                <EmailRowConnector
                  key={email.id}
                  email={email}
                  active={email.id === selectedId}
                  onSelect={() => navigate(`/email/${email.id}`)}
                  onNavigateProject={(projectId) => navigate(`/projects/${projectId}?tab=emails`)}
                />
              ))}
            </div>
          )}
        </div>
      }
      detail={selectedId ? <EmailDetailRoute emailId={selectedId} /> : null}
      emptyState={
        <EmptyState
          title="Select an email"
          body="Pick a row from the inbox to read it and run actions."
        />
      }
    />
  )
}

interface RowConnectorProps {
  email: import('@/types/domain').Email
  active: boolean
  onSelect(): void
  onNavigateProject(projectId: string): void
}

function EmailRowConnector({ email, active, onSelect, onNavigateProject }: RowConnectorProps) {
  const chip = useEmailChip(email.id)
  return (
    <EmailListRow
      email={email}
      isActive={active}
      chip={chip}
      onClick={onSelect}
      onNavigateProject={onNavigateProject}
    />
  )
}

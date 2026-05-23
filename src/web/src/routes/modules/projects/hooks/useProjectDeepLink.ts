import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

export type ProjectTab =
  | 'tasks'
  | 'scope'
  | 'emails'
  | 'files'
  | 'proposals'
  | 'invoices'
  | 'drafts'
  | 'activity'

const VALID_TABS: ReadonlySet<ProjectTab> = new Set([
  'tasks',
  'scope',
  'emails',
  'files',
  'proposals',
  'invoices',
  'drafts',
  'activity',
])

export interface ProjectDeepLink {
  tab: ProjectTab
  setTab(tab: ProjectTab): void
  taskId: string | null
  setTaskId(id: string | null): void
  open(taskId: string): void
  close(): void
}

export function useProjectDeepLink(): ProjectDeepLink {
  const [search, setSearch] = useSearchParams()
  const rawTab = search.get('tab')
  const tab: ProjectTab = rawTab && VALID_TABS.has(rawTab as ProjectTab) ? (rawTab as ProjectTab) : 'tasks'
  const taskId = search.get('task')

  const setTab = useCallback(
    (next: ProjectTab) => {
      setSearch(
        (prev) => {
          const sp = new URLSearchParams(prev)
          if (next === 'tasks') sp.delete('tab')
          else sp.set('tab', next)
          // Clear ?task= when leaving the tasks tab.
          if (next !== 'tasks') sp.delete('task')
          return sp
        },
        { replace: true },
      )
    },
    [setSearch],
  )

  const setTaskId = useCallback(
    (id: string | null) => {
      setSearch(
        (prev) => {
          const sp = new URLSearchParams(prev)
          if (id) sp.set('task', id)
          else sp.delete('task')
          return sp
        },
        { replace: true },
      )
    },
    [setSearch],
  )

  return {
    tab,
    setTab,
    taskId,
    setTaskId,
    open: (id) => setTaskId(id),
    close: () => setTaskId(null),
  }
}

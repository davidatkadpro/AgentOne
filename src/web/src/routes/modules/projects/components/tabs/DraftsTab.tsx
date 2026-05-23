import { useMemo } from 'react'
import { Copy, FileText } from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { useDrafts } from '@/api/drafts'
import { useProject, useProjectFiles } from '@/api/projects'
import { formatRelative } from '@/lib/time'

export interface DraftsTabProps {
  projectId: string
}

export function DraftsTab({ projectId }: DraftsTabProps) {
  const project = useProject(projectId)
  const drafts = useDrafts()
  const files = useProjectFiles(projectId)

  const matches = useMemo(() => {
    const number = project.data?.project.number ?? ''
    return (drafts.data ?? []).filter((d) => {
      if (!number) return false
      return d.title.includes(number) || d.path.includes(number)
    })
  }, [drafts.data, project.data?.project.number])

  const localDrafts = (files.data?.entries ?? []).filter(
    (e) => e.relativePath.startsWith('drafts/') && e.kind === 'file',
  )

  if (drafts.isLoading || project.isLoading) {
    return <div className="p-4 text-xs text-muted">Loading drafts…</div>
  }

  if (matches.length === 0 && localDrafts.length === 0) {
    return (
      <EmptyState
        title="No drafts for this project"
        body="Drafts produced by auto-distill that reference this project will appear here, along with files in projects/<n>/drafts/."
      />
    )
  }

  return (
    <div className="flex flex-col h-full overflow-auto scrollbar-thin">
      {matches.length > 0 ? (
        <section className="border-b border-border">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted">
            Wiki drafts
          </div>
          <ul>
            {matches.map((d) => (
              <li
                key={d.path}
                className="flex items-center gap-2 px-3 py-1.5 border-t border-border text-xs"
              >
                <FileText size={12} className="text-muted" />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{d.title}</div>
                  <div className="text-[10px] text-muted truncate">{d.path}</div>
                </div>
                <span className="text-[10px] text-muted">{d.noteCount} notes</span>
                <span className="text-[10px] text-muted">{formatRelative(Date.parse(d.mtime))}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {localDrafts.length > 0 ? (
        <section>
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted">
            Project drafts/
          </div>
          <ul>
            {localDrafts.map((e) => (
              <li
                key={e.relativePath}
                className="flex items-center gap-2 px-3 py-1.5 border-t border-border text-xs"
              >
                <FileText size={12} className="text-muted" />
                <span className="flex-1 truncate" title={e.relativePath}>
                  {e.name}
                </span>
                <button
                  onClick={() => void navigator.clipboard.writeText(e.relativePath)}
                  className="text-[10px] text-muted hover:text-fg"
                  aria-label="Copy path"
                >
                  <Copy size={10} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

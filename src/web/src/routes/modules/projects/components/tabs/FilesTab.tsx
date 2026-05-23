import { Copy, File, Folder } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/shared/EmptyState'
import { useProjectFiles } from '@/api/projects'
import type { ProjectFilesEntry } from '@/types/domain'

export interface FilesTabProps {
  projectId: string
}

export function FilesTab({ projectId }: FilesTabProps) {
  const files = useProjectFiles(projectId)
  if (files.isLoading) {
    return <div className="p-4 text-xs text-muted">Loading files…</div>
  }
  const entries = files.data?.entries ?? []
  const inEntries = entries.filter((e) => e.relativePath.startsWith('in/'))
  const draftEntries = entries.filter((e) => e.relativePath.startsWith('drafts/'))

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-3 py-2 flex items-center gap-2 text-[11px] text-muted">
        <span className="truncate flex-1" title={files.data?.rootPath}>
          {files.data?.rootPath || 'No folder configured'}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void navigator.clipboard.writeText(files.data?.rootPath ?? '')}
          disabled={!files.data?.rootPath}
        >
          <Copy size={10} /> Copy folder path
        </Button>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin grid grid-cols-2 gap-2 p-3">
        <FileColumn title="in/" entries={inEntries} />
        <FileColumn title="drafts/" entries={draftEntries} />
      </div>
    </div>
  )
}

function FileColumn({ title, entries }: { title: string; entries: ProjectFilesEntry[] }) {
  return (
    <div className="bg-surface border border-border rounded">
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted border-b border-border">
        {title}
      </div>
      {entries.length === 0 ? (
        <EmptyState title="Empty" body="No files in this folder yet." />
      ) : (
        <ul>
          {entries.map((e) => (
            <li
              key={e.relativePath}
              className="flex items-center gap-2 px-2 py-1 text-xs border-b border-border last:border-b-0"
            >
              {e.kind === 'directory' ? (
                <Folder size={12} className="text-accent" />
              ) : (
                <File size={12} className="text-muted" />
              )}
              <span className="flex-1 truncate" title={e.relativePath}>
                {e.name}
              </span>
              <span className="text-[10px] text-muted tabular-nums">
                {formatBytes(e.bytes)}
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
      )}
    </div>
  )
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

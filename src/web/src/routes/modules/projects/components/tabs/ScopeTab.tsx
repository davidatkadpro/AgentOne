import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/shared/EmptyState'
import { MarkdownView } from '@/components/shared/MarkdownView'
import { useProjectScope } from '@/api/projects'

export interface ScopeTabProps {
  projectId: string
}

export function ScopeTab({ projectId }: ScopeTabProps) {
  const scope = useProjectScope(projectId)
  if (scope.isLoading) {
    return <div className="p-4 text-xs text-muted">Loading scope…</div>
  }
  if (!scope.data?.markdown) {
    return (
      <EmptyState
        title="No scope file yet"
        body="The email scope-extractor skill writes one to projects/<n>/in/<date>/scope.md."
      />
    )
  }
  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-3 py-2 flex items-center gap-2 text-[11px] text-muted">
        <span className="truncate flex-1" title={scope.data.path ?? undefined}>
          {scope.data.path}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void navigator.clipboard.writeText(scope.data?.path ?? '')}
        >
          <Copy size={10} /> Copy path
        </Button>
      </div>
      <div
        className="flex-1 overflow-auto scrollbar-thin p-4 prose-sm text-sm text-fg"
        data-testid="scope-markdown"
      >
        <MarkdownView content={scope.data.markdown} />
      </div>
    </div>
  )
}

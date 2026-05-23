import { useEffect, useMemo, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { useRenderProposal } from '@/api/proposals'
import { api } from '@/lib/api'

export interface ProposalPreviewProps {
  proposalId: string | null
  /** When the estimate updates we re-render the preview after a short
   *  debounce. Phase 4 V1: keep it simple — markdown text, no syntax-highlight
   *  yet to avoid bringing a heavy markdown processor for v1. */
  watchKey: number
  /** Defaults to true. When false the preview only refreshes via the
   *  Regenerate button. */
  autoRegenerate?: boolean
}

interface PreviewState {
  text: string | null
  mtime: string | null
  loading: boolean
  error: string | null
}

export function ProposalPreview({
  proposalId,
  watchKey,
  autoRegenerate = true,
}: ProposalPreviewProps) {
  const render = useRenderProposal(proposalId ?? '')
  const [state, setState] = useState<PreviewState>({
    text: null,
    mtime: null,
    loading: false,
    error: null,
  })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRenderedKey = useRef<number | null>(null)

  const fetchPreview = useMemo(
    () => async (id: string): Promise<void> => {
      setState((s) => ({ ...s, loading: true, error: null }))
      try {
        // POST render { formats: ['md'] }, then read it back from the
        // download endpoint to get the raw bytes.
        const out = await api.post<{
          files: Array<{ kind: 'md' | 'pdf' | 'docx'; mtime: string }>
        }>(`/proposals/${id}/render`, { formats: ['md'] })
        const md = await fetch(`/api/proposals/${id}/download/md`, {
          credentials: 'same-origin',
        })
        if (!md.ok) {
          throw new Error(`Download failed (${md.status})`)
        }
        const text = await md.text()
        const fileMtime = out.files.find((f) => f.kind === 'md')?.mtime ?? null
        setState({ text, mtime: fileMtime, loading: false, error: null })
      } catch (err) {
        setState({
          text: null,
          mtime: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [],
  )

  useEffect(() => {
    if (!proposalId) return
    if (!autoRegenerate && lastRenderedKey.current !== null) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      lastRenderedKey.current = watchKey
      void fetchPreview(proposalId)
    }, 600)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [proposalId, watchKey, autoRegenerate, fetchPreview])

  if (!proposalId) {
    return (
      <div className="p-4 text-xs text-muted italic" data-testid="proposal-preview-empty">
        No proposal issued yet. Issue from the toolbar to render a preview.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="proposal-preview">
      <div className="px-3 py-1.5 border-b border-border flex items-center gap-2 text-[11px]">
        <span className="text-muted">
          {state.mtime
            ? `Rendered ${new Date(state.mtime).toLocaleString()}`
            : state.loading
              ? 'Rendering…'
              : 'Not yet rendered'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => proposalId && void fetchPreview(proposalId)}
          className="flex items-center gap-1 text-accent hover:underline"
          data-testid="proposal-preview-regenerate"
          disabled={render.isPending || state.loading}
        >
          <RotateCw size={11} /> Regenerate
        </button>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin p-3">
        {state.error ? (
          <div className="text-xs text-danger" data-testid="proposal-preview-error">
            Preview failed: {state.error}
          </div>
        ) : state.loading && state.text === null ? (
          <div className="text-xs text-muted">Loading preview…</div>
        ) : state.text === null ? (
          <div className="text-xs text-muted italic">No preview yet.</div>
        ) : (
          <pre
            className="text-xs whitespace-pre-wrap font-sans"
            data-testid="proposal-preview-text"
          >
            {state.text}
          </pre>
        )}
      </div>
    </div>
  )
}

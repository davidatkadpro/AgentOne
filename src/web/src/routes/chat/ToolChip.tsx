import { useEffect, useRef, useState } from 'react'
import { Loader2, Check, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/time'
import type { ToolChipState } from '@/types/domain'

function fmt(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export function ToolChip({ chip }: { chip: ToolChipState }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLSpanElement>(null)
  const icon =
    chip.status === 'pending' ? (
      <Loader2 size={10} className="animate-spin" />
    ) : chip.status === 'done' ? (
      <Check size={10} />
    ) : (
      <X size={10} />
    )
  const title =
    chip.status === 'failed' && chip.failMessage
      ? `${chip.failCode ?? 'failed'}: ${chip.failMessage}`
      : chip.tool

  // Dismiss the popover on outside-click and on Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const hasDetail =
    chip.args !== undefined || chip.result !== undefined || chip.failMessage !== undefined

  return (
    <span className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        title={title}
        onClick={() => hasDetail && setOpen((v) => !v)}
        data-testid="tool-chip"
        data-tool={chip.tool}
        data-status={chip.status}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md border',
          chip.status === 'pending' && 'bg-bg border-border text-muted',
          chip.status === 'done' && 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400',
          chip.status === 'failed' && 'bg-danger/10 border-danger/30 text-danger',
          hasDetail && 'cursor-pointer hover:opacity-90',
        )}
      >
        {icon}
        <span className="font-mono">{chip.tool}</span>
        {chip.status === 'done' && typeof chip.durationMs === 'number' ? (
          <span className="opacity-70">{formatDuration(chip.durationMs)}</span>
        ) : null}
        {chip.truncated ? <span className="text-warn">truncated</span> : null}
      </button>
      {open ? (
        <div
          role="dialog"
          data-testid="tool-chip-popover"
          className="absolute z-20 mt-1 left-0 w-96 max-w-[90vw] bg-surface border border-border rounded-md shadow-lg text-xs"
        >
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <span className="font-mono text-fg">{chip.tool}</span>
            <span className="text-muted text-[10px]">{chip.toolCallId}</span>
          </div>
          {chip.failMessage ? (
            <div className="px-3 py-2 border-b border-border text-danger">
              <div className="text-[10px] uppercase mb-1">{chip.failCode ?? 'error'}</div>
              <div>{chip.failMessage}</div>
            </div>
          ) : null}
          {chip.args !== undefined ? (
            <div className="px-3 py-2 border-b border-border">
              <div className="text-[10px] uppercase text-muted mb-1">Args</div>
              <pre
                className="bg-bg rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-40"
                data-testid="tool-chip-args"
              >
                {fmt(chip.args)}
              </pre>
            </div>
          ) : null}
          {chip.result !== undefined ? (
            <div className="px-3 py-2">
              <div className="text-[10px] uppercase text-muted mb-1">
                Result {chip.truncated ? <span className="text-warn">(truncated)</span> : null}
              </div>
              <pre
                className="bg-bg rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-40"
                data-testid="tool-chip-result"
              >
                {fmt(chip.result)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  )
}

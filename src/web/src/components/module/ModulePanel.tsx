import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface ModulePanelProps {
  kpiStrip?: ReactNode
  list: ReactNode
  detail: ReactNode | null
  emptyState?: ReactNode
  /** When true and no detail is selected, the right pane is hidden so the list's
   *  own empty state isn't doubled by a redundant "select something" pane. */
  listIsEmpty?: boolean
}

export function ModulePanel({ kpiStrip, list, detail, emptyState, listIsEmpty }: ModulePanelProps) {
  const collapse = listIsEmpty && !detail
  return (
    <div className="h-full flex flex-col">
      {kpiStrip ? <div className="border-b border-border">{kpiStrip}</div> : null}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* List pane:
         *   - <md: hidden once a detail is open; otherwise full-width.
         *   - md+: collapse → full-width; else fixed column with border.
         */}
        <div
          className={cn(
            'overflow-auto scrollbar-thin min-h-0',
            detail ? 'hidden md:block' : 'flex-1 md:flex-none',
            collapse
              ? 'md:flex-1'
              : 'md:flex-none md:border-r md:border-border md:w-[var(--module-list-width,360px)]',
          )}
        >
          {list}
        </div>
        {/* Detail pane:
         *   - <md: visible only when a detail is selected (list yields).
         *   - md+: always shown alongside the list (detail or emptyState).
         */}
        {collapse ? null : (
          <div
            className={cn(
              'flex-1 overflow-auto scrollbar-thin min-h-0',
              detail ? 'block' : 'hidden md:block',
            )}
          >
            {detail ?? emptyState}
          </div>
        )}
      </div>
    </div>
  )
}

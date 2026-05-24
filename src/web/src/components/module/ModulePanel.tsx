import type { ReactNode } from 'react'

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
      <div className="flex-1 flex overflow-hidden">
        <div
          className={
            collapse
              ? 'flex-1 overflow-auto scrollbar-thin'
              : 'border-r border-border overflow-auto scrollbar-thin shrink-0'
          }
          style={collapse ? undefined : { width: 'var(--module-list-width, 360px)' }}
        >
          {list}
        </div>
        {collapse ? null : (
          <div className="flex-1 overflow-auto scrollbar-thin">
            {detail ?? emptyState}
          </div>
        )}
      </div>
    </div>
  )
}

import type { ReactNode } from 'react'

export interface ModulePanelProps {
  kpiStrip?: ReactNode
  list: ReactNode
  detail: ReactNode | null
  emptyState?: ReactNode
}

export function ModulePanel({ kpiStrip, list, detail, emptyState }: ModulePanelProps) {
  return (
    <div className="h-full flex flex-col">
      {kpiStrip ? <div className="border-b border-border">{kpiStrip}</div> : null}
      <div className="flex-1 flex overflow-hidden">
        <div
          className="border-r border-border overflow-auto scrollbar-thin"
          style={{ width: 'var(--module-list-width, 360px)' }}
        >
          {list}
        </div>
        <div className="flex-1 overflow-auto scrollbar-thin">
          {detail ?? emptyState}
        </div>
      </div>
    </div>
  )
}

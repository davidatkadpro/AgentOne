import type { ReactNode } from 'react'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  body?: string
  action?: ReactNode
}

export function EmptyState({ icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-6 text-muted">
      {icon ? <div className="mb-3 opacity-60">{icon}</div> : null}
      <div className="text-sm font-medium text-fg">{title}</div>
      {body ? <div className="text-xs mt-1 max-w-sm">{body}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

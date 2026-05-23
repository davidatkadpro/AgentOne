import { cn } from '@/lib/cn'

export type SkeletonVariant = 'chat' | 'master-detail' | 'list'

export interface RouteSkeletonProps {
  variant: SkeletonVariant
}

function Bar({ className }: { className?: string }) {
  return <div className={cn('h-3 bg-surface rounded animate-pulse', className)} />
}

export function RouteSkeleton({ variant }: RouteSkeletonProps) {
  if (variant === 'chat') {
    return (
      <div className="mx-auto max-w-[760px] p-6 space-y-4">
        <Bar className="w-1/2" />
        <Bar className="w-full" />
        <Bar className="w-5/6" />
        <Bar className="w-3/4" />
        <Bar className="w-2/3" />
      </div>
    )
  }
  if (variant === 'master-detail') {
    return (
      <div className="flex h-full">
        <div className="w-[360px] border-r border-border p-4 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Bar key={i} className="w-full" />
          ))}
        </div>
        <div className="flex-1 p-4 space-y-3">
          <Bar className="w-1/3" />
          <Bar className="w-full h-32" />
        </div>
      </div>
    )
  }
  return (
    <div className="p-4 space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <Bar key={i} className="w-full" />
      ))}
    </div>
  )
}

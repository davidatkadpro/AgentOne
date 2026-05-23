import { ErrorBoundary } from 'react-error-boundary'
import type { FallbackProps } from 'react-error-boundary'
import { Button } from '@/components/ui/Button'
import { useQueryClient } from '@tanstack/react-query'

function Fallback({ error, resetErrorBoundary }: FallbackProps) {
  const qc = useQueryClient()
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="text-sm font-semibold text-danger mb-2">Something went wrong</div>
        <pre className="text-xs text-muted bg-surface border border-border rounded p-3 mb-3 whitespace-pre-wrap text-left">
          {error.message}
        </pre>
        <div className="flex gap-2 justify-center">
          <Button
            variant="secondary"
            onClick={() => {
              void qc.invalidateQueries()
              resetErrorBoundary()
            }}
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              console.error('[error-boundary]', error)
            }}
          >
            Log details
          </Button>
        </div>
      </div>
    </div>
  )
}

export function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary FallbackComponent={Fallback}>{children}</ErrorBoundary>
}

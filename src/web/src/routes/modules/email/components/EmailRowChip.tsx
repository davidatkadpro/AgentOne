import { Check, Loader2, X, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { EmailActionChip } from '@/types/domain'

export interface EmailRowChipProps {
  chip: EmailActionChip | null
  /** Optional — when provided, success chips navigate to `/projects/<id>`. */
  onNavigateProject?(projectId: string): void
}

export function EmailRowChip({ chip, onNavigateProject }: EmailRowChipProps) {
  if (!chip) return null
  const isRunning = chip.status === 'running'
  const isDone = chip.status === 'completed'
  const isFailed = chip.status === 'failed'
  const projectId = chip.result?.projectId
  const clickable = isDone && projectId && onNavigateProject
  const Container: React.ElementType = clickable ? 'button' : 'span'
  return (
    <Container
      onClick={
        clickable
          ? (e: React.MouseEvent) => {
              e.stopPropagation()
              onNavigateProject?.(projectId)
            }
          : undefined
      }
      className={cn(
        'inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[10px] font-medium',
        isRunning && 'bg-accent/10 text-accent',
        isDone && 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
        isFailed && 'bg-danger/10 text-danger',
      )}
      title={isFailed ? `Action "${chip.action}" failed` : chip.action}
      data-testid={`email-chip-${chip.status}`}
    >
      {isRunning ? <Loader2 size={10} className="animate-spin" /> : null}
      {isDone ? <Check size={10} /> : null}
      {isFailed ? <X size={10} /> : null}
      {isRunning ? `${chip.action}…` : null}
      {isDone ? <span className="flex items-center gap-0.5">filed <ArrowRight size={8} /></span> : null}
      {isFailed ? 'failed' : null}
    </Container>
  )
}

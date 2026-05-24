import { cn } from '@/lib/cn'
import { MarkdownView } from '@/components/shared/MarkdownView'
import { AgentAvatar } from '@/components/shared/AgentAvatar'
import { useHealth } from '@/api/health'
import { ToolChip } from './ToolChip'
import type { Turn, ToolChipState } from '@/types/domain'

export interface MessageItemProps {
  turn: Turn
  toolChips: ToolChipState[]
}

const components = {
  code({ children, className }: { children?: React.ReactNode; className?: string }) {
    return (
      <code className={cn('rounded bg-surface px-1 py-0.5 text-xs', className)}>{children}</code>
    )
  },
  pre({ children }: { children?: React.ReactNode }) {
    return <pre className="bg-surface rounded-md p-3 overflow-x-auto text-xs">{children}</pre>
  },
}

export function MessageItem({ turn, toolChips }: MessageItemProps) {
  const isUser = turn.role === 'user'
  const isAssistant = turn.role === 'assistant'
  const health = useHealth()
  if (turn.role === 'tool' || turn.role === 'system') return null

  if (isAssistant) {
    return (
      <div className="flex gap-2.5 items-start">
        <AgentAvatar profile={health.data?.agentProfile} size="sm" className="mt-0.5" />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <div className="text-sm leading-relaxed border-l-2 border-accent/30 pl-3 prose-sm">
            <MarkdownView content={turn.content} highlight components={components} />
          </div>
          {toolChips.length > 0 ? (
            <div className="flex flex-wrap gap-1 mt-1 pl-3">
              {toolChips.map((c) => (
                <ToolChip key={c.toolCallId} chip={c} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-full text-sm leading-relaxed',
          isUser
            ? 'bg-surface border border-border rounded-2xl rounded-tr-sm px-3 py-2 max-w-[80%]'
            : 'w-full prose-sm',
        )}
      >
        <span className="whitespace-pre-wrap">{turn.content}</span>
      </div>
    </div>
  )
}

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { cn } from '@/lib/cn'
import { ToolChip } from './ToolChip'
import type { Turn, ToolChipState } from '@/types/domain'

export interface MessageItemProps {
  turn: Turn
  toolChips: ToolChipState[]
}

export function MessageItem({ turn, toolChips }: MessageItemProps) {
  const isUser = turn.role === 'user'
  const isAssistant = turn.role === 'assistant'
  if (turn.role === 'tool' || turn.role === 'system') return null
  return (
    <div
      className={cn(
        'flex flex-col gap-1',
        isUser ? 'items-end' : 'items-start',
      )}
    >
      <div
        className={cn(
          'max-w-full text-sm leading-relaxed',
          isUser
            ? 'bg-surface border border-border rounded-2xl rounded-tr-sm px-3 py-2 max-w-[80%]'
            : 'w-full prose-sm',
        )}
      >
        {isAssistant ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              code({ children, className }) {
                return (
                  <code className={cn('rounded bg-surface px-1 py-0.5 text-xs', className)}>{children}</code>
                )
              },
              pre({ children }) {
                return <pre className="bg-surface rounded-md p-3 overflow-x-auto text-xs">{children}</pre>
              },
            }}
          >
            {turn.content}
          </ReactMarkdown>
        ) : (
          <span className="whitespace-pre-wrap">{turn.content}</span>
        )}
      </div>
      {isAssistant && toolChips.length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-1">
          {toolChips.map((c) => (
            <ToolChip key={c.toolCallId} chip={c} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

import { Paperclip } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/time'
import type { Email, EmailActionChip } from '@/types/domain'
import { EmailRowChip } from './EmailRowChip'

export interface EmailListRowProps {
  email: Email
  isActive: boolean
  chip: EmailActionChip | null
  onClick(): void
  onNavigateProject?(projectId: string): void
}

export function EmailListRow({ email, isActive, chip, onClick, onNavigateProject }: EmailListRowProps) {
  const unread = !email.isRead
  return (
    <button
      data-testid={`email-row-${email.id}`}
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-2 border-b border-border',
        'hover:bg-surface',
        isActive && 'bg-accent/10',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'flex-1 truncate text-xs',
            unread ? 'font-semibold text-fg' : 'text-muted',
          )}
        >
          {email.fromName ?? email.fromAddress}
        </span>
        <span className="text-[10px] text-muted tabular-nums shrink-0">
          {formatRelative(email.receivedAt)}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <div className="flex-1 min-w-0">
          <div
            className={cn(
              'text-sm truncate',
              unread ? 'font-medium text-fg' : 'text-muted',
            )}
          >
            {email.subject ?? <span className="italic">(no subject)</span>}
          </div>
          {email.snippet ? (
            <div className="text-[11px] text-muted truncate">{email.snippet}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {email.hasAttachments ? <Paperclip size={12} className="text-muted" /> : null}
          {email.filedProjectId ? (
            <span
              className="inline-flex items-center h-5 px-1.5 rounded-md text-[10px] bg-surface border border-border text-muted"
              title={`Filed to ${email.filedProjectId}`}
            >
              filed
            </span>
          ) : null}
          <EmailRowChip chip={chip} onNavigateProject={onNavigateProject} />
        </div>
      </div>
    </button>
  )
}

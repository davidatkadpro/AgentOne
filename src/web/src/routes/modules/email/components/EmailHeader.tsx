import { ArrowRight, Mail } from 'lucide-react'
import type { Email, EmailActionChip } from '@/types/domain'
import { EmailRowChip } from './EmailRowChip'

export interface EmailHeaderProps {
  email: Email
  chip: EmailActionChip | null
  onMarkUnread(): void
  onNavigateProject?(projectId: string): void
}

export function EmailHeader({ email, chip, onMarkUnread, onNavigateProject }: EmailHeaderProps) {
  return (
    <div className="px-4 py-3 border-b border-border">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-fg">
            {email.subject ?? <span className="italic">(no subject)</span>}
          </h2>
          <div className="mt-1 text-xs text-muted truncate">
            <a
              href={`mailto:${email.fromAddress}`}
              className="text-accent hover:underline inline-flex items-center gap-1"
            >
              <Mail size={10} />
              {email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress}
            </a>
            <span className="mx-2">·</span>
            <time dateTime={new Date(email.receivedAt).toISOString()}>
              {new Date(email.receivedAt).toLocaleString()}
            </time>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {email.filedProjectId ? (
            <button
              onClick={() => onNavigateProject?.(email.filedProjectId!)}
              className="text-[11px] text-accent hover:underline inline-flex items-center gap-1"
              data-testid="email-header-filed"
            >
              Filed <ArrowRight size={10} />
            </button>
          ) : null}
          <EmailRowChip chip={chip} onNavigateProject={onNavigateProject} />
          {email.isRead ? (
            <button
              onClick={onMarkUnread}
              className="text-[11px] text-muted hover:text-fg"
              data-testid="email-mark-unread"
            >
              Mark unread
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

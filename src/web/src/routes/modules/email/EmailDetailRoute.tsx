import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EmptyState } from '@/components/shared/EmptyState'
import { InlineSessionStream } from '@/components/module/InlineSessionStream'
import { useEmail, useEmailBody, useMarkRead } from '@/api/email'
import { useEmailChip } from '@/stores/email-chips'
import { EmailHeader } from './components/EmailHeader'
import { EmailBody } from './components/EmailBody'
import { EmailAttachments } from './components/EmailAttachments'
import { EmailActionToolbar } from './components/EmailActionToolbar'

export interface EmailDetailRouteProps {
  emailId: string
}

export function EmailDetailRoute({ emailId }: EmailDetailRouteProps) {
  const navigate = useNavigate()
  const detail = useEmail(emailId)
  const body = useEmailBody(emailId)
  const markRead = useMarkRead(emailId)
  const chip = useEmailChip(emailId)
  const [dispatchedSessionId, setDispatchedSessionId] = useState<string | null>(null)
  const [streamOpen, setStreamOpen] = useState(true)

  useEffect(() => {
    if (detail.data?.email && !detail.data.email.isRead) {
      void markRead.mutateAsync({ isRead: true }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.email?.id, detail.data?.email?.isRead])

  if (detail.isLoading) {
    return <div className="p-4 text-xs text-muted">Loading email…</div>
  }
  if (!detail.data) {
    return <EmptyState title="Email not found" body="The email may have been removed from the source." />
  }
  const email = detail.data.email

  return (
    <div className="flex flex-col h-full">
      <EmailHeader
        email={email}
        chip={chip}
        onMarkUnread={() => void markRead.mutate({ isRead: false })}
        onNavigateProject={(projectId) => navigate(`/projects/${projectId}?tab=emails`)}
      />
      <EmailActionToolbar
        emailId={email.id}
        onSessionSpawned={(sessionId) => {
          setDispatchedSessionId(sessionId)
          setStreamOpen(true)
        }}
      />
      {dispatchedSessionId ? (
        <div className="border-b border-border px-3 py-2">
          <InlineSessionStream
            sessionId={dispatchedSessionId}
            open={streamOpen}
            onOpenChange={setStreamOpen}
          />
        </div>
      ) : null}
      <div className="flex-1 overflow-auto scrollbar-thin">
        <EmailBody emailId={email.id} />
        {body.data?.attachments && body.data.attachments.length > 0 ? (
          <EmailAttachments emailId={email.id} attachments={body.data.attachments} />
        ) : null}
      </div>
    </div>
  )
}

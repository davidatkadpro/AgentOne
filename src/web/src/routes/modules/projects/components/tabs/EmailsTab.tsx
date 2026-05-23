import { useNavigate } from 'react-router-dom'
import { EmptyState } from '@/components/shared/EmptyState'
import { useEmails } from '@/api/email'
import { useEmailChip } from '@/stores/email-chips'
import { EmailListRow } from '../../../email/components/EmailListRow'
import type { Email } from '@/types/domain'

export interface EmailsTabProps {
  projectId: string
}

export function EmailsTab({ projectId }: EmailsTabProps) {
  const navigate = useNavigate()
  const emails = useEmails({ projectId, filed: true })
  if (emails.isLoading) {
    return <div className="p-4 text-xs text-muted">Loading emails…</div>
  }
  const rows = emails.data ?? []
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No emails filed to this project yet"
        body="When you file an email here, it'll show up in this tab automatically."
      />
    )
  }
  return (
    <div className="flex flex-col h-full overflow-auto scrollbar-thin">
      {rows.map((email: Email) => (
        <EmailRowConnector
          key={email.id}
          email={email}
          onSelect={() => navigate(`/email/${email.id}`)}
        />
      ))}
    </div>
  )
}

function EmailRowConnector({ email, onSelect }: { email: Email; onSelect(): void }) {
  const chip = useEmailChip(email.id)
  return <EmailListRow email={email} isActive={false} chip={chip} onClick={onSelect} />
}

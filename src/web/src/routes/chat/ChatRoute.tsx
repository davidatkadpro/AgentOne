import { useParams, Link } from 'react-router-dom'
import { MessageSquarePlus } from 'lucide-react'
import { useSession } from '@/api/sessions'
import { useSessionSubscription } from '@/lib/ws'
import { useSessionStreamStore } from '@/stores/session-stream'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { CancelButton } from './CancelButton'
import { ChatHeader } from './ChatHeader'
import { ProfileMismatchBanner } from './ProfileMismatchBanner'
import { RouteSkeleton } from '@/components/shared/RouteSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/Button'
import { useUiStore } from '@/stores/ui'

export function ChatRoute() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const { setNewChatDialogOpen } = useUiStore()
  const detail = useSession(sessionId)
  useSessionSubscription(sessionId)
  const stream = useSessionStreamStore((s) => (sessionId ? s.byId[sessionId] : undefined))

  if (!sessionId) {
    return (
      <EmptyState
        icon={<MessageSquarePlus size={36} />}
        title="Pick a session from the sidebar"
        body="Or start a new conversation."
        action={<Button onClick={() => setNewChatDialogOpen(true)}>New conversation</Button>}
      />
    )
  }
  if (detail.isPending) return <RouteSkeleton variant="chat" />
  if (detail.error) {
    return (
      <EmptyState
        title="Couldn't load this session"
        body={detail.error instanceof Error ? detail.error.message : String(detail.error)}
        action={
          <Link to="/chat" className="text-accent hover:underline text-xs">
            Back to chat
          </Link>
        }
      />
    )
  }

  const turnInFlight = !!stream?.activeAssistant
  return (
    <div className="flex flex-col h-full">
      {stream?.profileMismatch ? (
        <ProfileMismatchBanner requiredProfile={stream.profileMismatch.requiredProfile} />
      ) : null}
      <ChatHeader sessionId={sessionId} />
      <MessageList sessionId={sessionId} />
      <div className="flex items-center justify-end px-3 md:px-6 py-1">
        <CancelButton sessionId={sessionId} visible={turnInFlight} />
      </div>
      <Composer sessionId={sessionId} disabled={!!stream?.profileMismatch} />
    </div>
  )
}
